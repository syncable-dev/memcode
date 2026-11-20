# Dedicated MemCode beta Team service

This stack runs Team planning synchronization, comments, activity, shared worker
conversations and review reports, and explicitly published small results. Workers, provider accounts, Git checkouts,
Memtrace analysis and local graphs remain on each developer's computer.
It is a single-host early beta, not a highly available service.

`MemCodeBetaRelay` owns its own VPC, subnet, public address, HTTPS endpoint,
runtime role, encrypted data disk, KMS key, private software/backup buckets and
30-day audit bucket. It must not reuse the public download bucket or change
existing application instances, stacks, security groups or pilot tunnels.
Only a new hostname record is added to the existing public DNS zone.

The unprivileged Node service listens on loopback behind unprivileged Caddy.
Only ports 80/443 are public; 80 redirects to HTTPS and handles ACME. There is
no SSH key or open SSH port. Operators use Systems Manager with temporary IAM
credentials. IMDSv2 is required. Only the scoped instance role can access
private bundles and backups. Do not print its local `admin.private.json`,
signed account tokens, invitation capabilities or Team documents into logs.
Caddy access logging is intentionally disabled so authentication requests are
not copied into a request log. Journald retention is 30 days/128 MB. The
stack-owned CloudTrail records object data events only for its two private
buckets, with log-integrity validation. It does not collect other products'
regional management operations. The runtime role explicitly denies Parameter
Store reads so its SSM agent permissions do not grant access to unrelated
application parameters.

## Build and review

1. Run `node deploy/aws/generate-relay-template.mjs` after bootstrap edits.
2. Run `node --import tsx --test tests/relay-deployment.test.ts` and a shell
   syntax check for `relay.bootstrap.sh`.
3. Run AWS `cloudformation validate-template`, then create a **CREATE** change
   set for the new stack with `CAPABILITY_IAM`. Review every resource addition
   and the exact AWS account/region. Do not execute unrelated changes.
4. Local cfn-lint/Guard are optional operator tools and are not bundled here.
   Report honestly when those layers did not run; AWS template/change-set
   validation is not a substitute for runtime acceptance.
5. Run `node deploy/aws/package-relay.mjs`. The ignored
   `tmp/relay-deploy/package.json` records the archive SHA-256. The package
   contains only bundled relay code, launcher, provenance and notices. No
   source checkout, engine, model, account state or Team state is packaged.

Node and Caddy versions and official checksum sources are pinned in
`relay-runtimes.json`. Bootstrap verifies SHA-256 for both and additionally the
published Caddy SHA-512. These pinned HTTPS-sourced hashes are not a claim of
independent signer-signature verification. Ubuntu packages use its signed apt
repository. Review pins before changing them.

## Deploy after stack review

Confirm `aws sts get-caller-identity` matches the explicitly reviewed account.
Execute only the reviewed change set. The first boot prepares the dedicated
host but does not publish an unauthenticated placeholder service.

Upload the reviewed tarball to the stack output `PrivateArtifactBucket`, under
`bundles/<SHA-256>.tar.gz`. That bucket remains private. Use Systems Manager
Run Command against only the output `InstanceId` to run `install-relay.py`
with that same SHA-256. The installer accepts five exact ordinary files,
rejects links/unexpected entries, checks the digest and replaces only code.
There is no npm install, arbitrary repository checkout or project build on the
host. Never feed credentials or user-supplied commands into this process.

Before publishing discovery, check HTTPS `GET /v1/service`: it must report
`version:1`, `selfServiceTeams:true`, `accountTeamLimit:3`, `workflowRoles:1`
and `workerActivity:1` and `workerSessions:1`. Confirm a protected
operation rejects missing/invalid identity, and run the authenticated desktop
acceptance flow. The relay verifier uses the official Memtrace JWKS and
requires the exact advertised HTTPS origin as the token audience.

Shared sessions require this service update as well as an updated desktop app.
Keep the retained journal and existing memberships intact when updating code.
The session journal is separate from board history, so conversation updates do
not rewrite stories or reset cycles. A session command is authenticated as its
real author and routed only to its current owner device. Approvals and private
harness resume credentials never pass through the relay. Test an older client
against the new service before publication; unknown session journal records must
not alter its planning state.

Self-service is explicitly enabled by this service's reviewed launcher. It
allows up to three created-or-owned Teams per verified account and at most
100 Teams in this pilot. It does not limit the number of memberships to three.
Do not distribute the operator capability or a `service.private.json` bootstrap
secret to normal users. They sign in through the normal Memtrace browser flow.

## Persistence, backup and restore

The live journal and ACME state live on a separate encrypted EBS disk retained
on stack deletion/replacement. A host reboot remounts the exact volume and
systemd restarts the services. A CloudWatch alarm requests AWS host recovery
after a system-status failure. Single-host maintenance still interrupts access;
desktop clients retain local state and must reconnect/catch up.

A daily timer briefly pauses the relay while making a consistent compressed
checkpoint. A trap restarts it even if archiving/upload fails; the upload runs
after restart. Backups are private, encrypted, versioned, retained for 30 days
and isolated from public release storage. The pilot recovery-point objective
is up to one day; this is not continuous cross-region backup.

Bootstrap restores the newest checkpoint only onto an empty state directory.
Existing retained state is never overwritten by a backup. Restore rejects
links, paths outside `state/` and `caddy/`, and oversized archives. It does not
restore an active process lock. Test recovery using a separate disposable
stack before trusting recovery for important work. Do not delete the retained
KMS key or data volume while live state/backups still depend on them.

## Pilot cost basis

Official AWS Pricing API checked 2026-11-16 in Frankfurt (`eu-central-1`):
Linux `t4g.small` is $0.0192/hour; gp3 is $0.0952/GB-month. AWS public IPv4 is
$0.005/hour. At 730 hours, one host + 8 GB root + 16 GB state + one public
address is about **$19.95/month**, before KMS, private backups, audit requests,
DNS and transfer. A small pilot estimate is roughly $22–25/month; actual
storage/traffic costs vary. Standard CPU credits avoid unlimited surplus
charges but sustained load can throttle. No free-tier credit is assumed.

References: [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS pricing](https://aws.amazon.com/ebs/pricing/),
[public IPv4 pricing](https://aws.amazon.com/vpc/pricing/),
[S3 pricing](https://aws.amazon.com/s3/pricing/).
