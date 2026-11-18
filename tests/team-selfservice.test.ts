import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { startTeamRelay } from "../runtime/team/relay";
import { TeamSyncClient } from "../runtime/team/client";
import { discoverOfficialTeamService } from "../runtime/team/discovery";
import { createMemtraceIdentityVerifier, type TeamIdentityProofVerifier, type MemtraceIdentityPublicKey } from "../runtime/team-identity";
import { initialState } from "../src/seed";

const verifier: TeamIdentityProofVerifier = async (proof, challenge) => {
  const value = JSON.parse(proof);
  if (!["alice", "bob"].includes(value.subject) || value.nonce !== challenge.nonce || value.audience !== challenge.audience) throw Error("Invalid test proof");
  return { issuer: "memtrace", subject: value.subject, name: value.subject.toUpperCase() };
};
async function fixture(selfServiceTeams = true) {
  const root = await mkdtemp(join(tmpdir(), "memcode-team-selfservice-"));
  const options = { dataDir: join(root, "relay"), port: 0, verifyIdentity: verifier, selfServiceTeams };
  let relay = await startTeamRelay(options);
  const request = async (path: string, input?: unknown, capability?: string) => {
    const response = await fetch(relay.url + path, { method: input === undefined ? "GET" : "POST", headers: {
      ...(input === undefined ? {} : {"content-type":"application/json"}), ...(capability ? {authorization:"Bearer " + capability} : {})
    }, ...(input === undefined ? {} : {body:JSON.stringify(input)}) });
    return {status:response.status, body:await response.json() as any};
  };
  const create = async (subject = "alice", capability?: string, operation?: {opId:string;deviceId:string}, name = "Team") => {
    const {body:challenge} = await request("/v1/team-auth/challenge");
    return request("/v1/teams", {name, opId:operation?.opId ?? randomUUID(), deviceId:operation?.deviceId ?? randomUUID(), deviceName:"Synthetic device",
      nonce:challenge.nonce, proof:JSON.stringify({...challenge,subject})},capability);
  };
  return {root,request,create,get relay(){return relay;}, async restart(){const port=Number(new URL(relay.url).port);await relay.close();relay=await startTeamRelay({...options,port});}, async close(){await relay.close();await rm(root,{recursive:true,force:true});}};
}

test("Team self-service is explicitly opt-in and private operator creation still requires verified identity", async () => {
  const f = await fixture(false);
  try {
    const service = await f.request("/v1/service");
    assert.equal(service.status, 200);
    assert.equal(service.body.selfServiceTeams, false);
    assert.equal(service.body.workerActivity, 1);
    assert.equal((await f.create()).status,403);
    assert.equal((await f.create("forged",f.relay.adminCapability)).status,403);
    const valid = await f.create("alice",f.relay.adminCapability);
    assert.equal(valid.status,201); assert.equal(valid.body.team.members[0].name,"ALICE");
  } finally {await f.close();}
});
test("self-service limits are atomic per verified account, durable across restart, and permit idempotent retries", async () => {
  const f = await fixture();
  try {
    const operation={opId:randomUUID(),deviceId:randomUUID()};
    const first=await f.create("alice",undefined,operation,"First Team"); assert.equal(first.status,201);
    const attempts=await Promise.all(Array.from({length:5},()=>f.create()));
    assert.equal(attempts.filter(value=>value.status===201).length,2);
    assert.equal(attempts.filter(value=>value.status===429&&value.body.error.code==="ACCOUNT_TEAM_LIMIT").length,3);
    assert.equal((await f.create("bob")).status,201);
    await f.restart();
    assert.equal((await f.create()).status,429);
    const retry=await f.create("alice",undefined,operation,"First Team");
    assert.equal(retry.status,201);assert.equal(retry.body.team.id,first.body.team.id);
    assert.equal((await f.create("alice",f.relay.adminCapability)).status,201);
  } finally {await f.close();}
});
test("a new client discovers an opted-in relay and creates a real named Team without any operator secret", async () => {
  const f=await fixture(),state=initialState(),directory=join(f.root,"new-client");
  const client=new TeamSyncClient(()=>state,directory,async()=>{}, {background:false,
    serviceDiscovery:async()=>({endpoint:f.relay.url}),identityProof:async challenge=>JSON.stringify({...challenge,subject:"alice"})});
  try {
    await client.initialize();const listing=await client.teamsList();assert.equal(listing.canCreate,true);assert.equal(listing.configured,true);
    const team=await client.createTeamWorkspace({name:"Fresh installation"});assert.equal(team.name,"Fresh installation");assert.equal(team.identity,"memtrace");assert.equal(team.members[0].name,"ALICE");
    assert.equal((await client.teamsList()).teams.length,1);
  } finally {await client.close();await f.close();}
});
test("private Team service configuration takes precedence over official discovery", async () => {
  const f=await fixture(false),state=initialState(),directory=join(f.root,"operator-client");let discovered=false;
  await mkdir(join(directory,"team"),{recursive:true});await writeFile(join(directory,"team","service.private.json"),JSON.stringify({endpoint:f.relay.url,bootstrapSecret:f.relay.adminCapability}));
  const client=new TeamSyncClient(()=>state,directory,async()=>{}, {background:false,serviceDiscovery:async()=>{discovered=true;throw Error("Must not discover");},identityProof:async challenge=>JSON.stringify({...challenge,subject:"alice"})});
  try {await client.initialize();assert.equal((await client.teamsList()).canCreate,true);assert.equal((await client.createTeamWorkspace({name:"Operator"})).name,"Operator");assert.equal(discovered,false);}
  finally {await client.close();await f.close();}
});
test("official discovery sends no credentials and accepts only the versioned public HTTPS origin contract", async () => {
  let requested="",options:RequestInit|undefined;
  const fetcher=(value:unknown)=>(async (url,init)=>{requested=String(url);options=init;return Response.json(value);}) as typeof fetch;
  assert.deepEqual(await discoverOfficialTeamService(fetcher({version:1,teamRelay:{endpoint:"https://team.example.test"}})),{endpoint:"https://team.example.test"});
  assert.equal(requested,"https://www.memtrace.io/api/memcode/services");assert.equal(options?.redirect,"error");assert.equal(options?.body,undefined);
  assert.equal(new Headers(options?.headers).get("authorization"),null);
  assert.equal(await discoverOfficialTeamService(fetcher({version:1,teamRelay:null})),undefined);
  for(const value of [{version:2,teamRelay:null},{version:1},...[
    "http://team.example.test","https://user:secret@team.example.test","https://team.example.test/path","https://team.example.test?secret=x","https://127.0.0.1","https://team.example.test:444"
  ].map(endpoint=>({version:1,teamRelay:{endpoint}}))]) await assert.rejects(()=>discoverOfficialTeamService(fetcher(value)));
  const huge=(async()=>new Response(" ".repeat(5000))) as typeof fetch;
  await assert.rejects(()=>discoverOfficialTeamService(huge));
});
test("self-service accepts the production Ed25519 verifier and rejects unsigned account claims", async () => {
  const root=await mkdtemp(join(tmpdir(),"memcode-signed-selfservice-")),pair=generateKeyPairSync("ed25519");
  const key={...pair.publicKey.export({format:"jwk"}),kid:"synthetic-self-service",alg:"EdDSA",use:"sig"} as MemtraceIdentityPublicKey;
  const relay=await startTeamRelay({dataDir:root,port:0,selfServiceTeams:true,verifyIdentity:createMemtraceIdentityVerifier({loadKeys:async()=>({keys:[key]})})});
  try {
    const create=async(tamper:boolean)=>{
      const challenge=await(await fetch(relay.url+"/v1/team-auth/challenge")).json();
      const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:"EdDSA",typ:"JWT",kid:key.kid})).toString("base64url");
      const body=Buffer.from(JSON.stringify({iss:"https://memtrace.io",aud:challenge.audience,nonce:challenge.nonce,purpose:"memcode-team",sub:"actual-signed-test-subject",name:"Signed member",email_verified:false,iat:now,exp:now+240,jti:randomUUID()})).toString("base64url");
      const proof=head+"."+body+"."+sign(null,Buffer.from(head+"."+body),pair.privateKey).toString("base64url");
      const response=await fetch(relay.url+"/v1/teams",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Signed self-service",opId:randomUUID(),deviceId:randomUUID(),deviceName:"Test device",nonce:challenge.nonce,proof:tamper?proof.slice(0,-5)+"aaaaa":proof})});
      return{status:response.status,body:await response.json()};
    };
    assert.equal((await create(true)).status,403);
    const valid=await create(false);assert.equal(valid.status,201);assert.equal(valid.body.credential.subject,"actual-signed-test-subject");assert.equal(valid.body.team.members[0].name,"Signed member");
  } finally {await relay.close();await rm(root,{recursive:true,force:true});}
});
