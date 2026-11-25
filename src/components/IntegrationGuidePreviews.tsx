import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  FileSpreadsheet,
  FileText,
  Hash,
  Image as ImageIcon,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Presentation,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Action, Label, Row } from "./GuideParts";
import { IntegrationMark } from "./IntegrationMark";

/**
 * The Integrations guide's illustrations. The people and the project are made up; what
 * MemCode says in Slack is what it really says there.
 */

const title = "The docs search goes blank on iPhone";

function Person({ name, at, children }: { name: string; at: string; children: ReactNode }) {
  return (
    <div className="guide-slack-message">
      <span className="guide-slack-avatar">
        {name
          .split(" ")
          .map((word) => word[0])
          .join("")}
      </span>
      <div>
        <Row>
          <strong>{name}</strong>
          <Label>{at}</Label>
        </Row>
        {children}
      </div>
    </div>
  );
}
function MemCodeSays({ at, children }: { at: string; children: ReactNode }) {
  return (
    <div className="guide-slack-message memcode">
      <span className="guide-slack-avatar">M</span>
      <div>
        <Row>
          <strong>MemCode</strong>
          <span className="guide-slack-app">APP</span>
          <Label>{at}</Label>
        </Row>
        {children}
      </div>
    </div>
  );
}
const At = () => <span className="guide-slack-mention">@MemCode</span>;
function Files({ names }: { names: string[] }) {
  return (
    <div className="guide-slack-files">
      {names.map((name) => (
        <span key={name}>
          {/\.(png|jpe?g)$/.test(name) ? (
            <ImageIcon size={12} />
          ) : name.endsWith(".xlsx") ? (
            <FileSpreadsheet size={12} />
          ) : name.endsWith(".pptx") ? (
            <Presentation size={12} />
          ) : (
            <FileText size={12} />
          )}
          {name}
        </span>
      ))}
    </div>
  );
}
function Channel({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="guide-slack-channel">
      <Row>
        <Hash size={14} />
        <strong>{name}</strong>
        <span className="guide-preview-spacer" />
        <Label>Example Slack channel</Label>
      </Row>
      {children}
    </div>
  );
}

function ConnectPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <div>
          <Label>Settings · Integrations</Label>
          <h4>Bring in the tools your team works in.</h4>
        </div>
      </Row>
      <div className="guide-integration-row">
        <span className="guide-integration-mark">
          <IntegrationMark id="slack" size={18} />
        </span>
        <div>
          <strong>Slack</strong>
          <p>Reports land in your project’s Inbox, with their files and links.</p>
        </div>
        <Action>Add to Slack</Action>
      </div>
      <Row className="guide-preview-cycle-flow">
        <span>Add to Slack</span>
        <ArrowRight size={13} />
        <span>Choose Allow in your browser</span>
        <ArrowRight size={13} />
        <span>Connected</span>
      </Row>
      <div className="guide-preview-callout">
        <ShieldCheck size={18} />
        <div>
          <strong>The whole workspace, once</strong>
          <p>
            There is nothing to set up for each channel. Your code and your board
            stay on this computer.
          </p>
        </div>
      </div>
    </>
  );
}

function ReportPreview() {
  return (
    <Channel name="support">
      <Person name="Dana Kowalski" at="09:18">
        <p>
          <At /> {title}. Three customers wrote in about it today.
        </p>
        <Files names={["search-blank.png", "ticket-8812.pdf", "console.log"]} />
      </Person>
      <MemCodeSays at="09:18">
        <p>
          Added to <b>Lumen</b> › Inbox with 3 files: “{title}”.
        </p>
      </MemCodeSays>
      <div className="guide-preview-divider" />
      <Person name="Sam Okafor" at="09:31">
        <p>
          <At /> Same on iPad. The devices we tried are in the sheet.
        </p>
        <Files names={["devices-tested.xlsx"]} />
      </Person>
      <MemCodeSays at="09:31">
        <p>
          Added your comment with 1 file to “{title}” in <b>Lumen</b> › Inbox.
        </p>
      </MemCodeSays>
    </Channel>
  );
}

function FormPreview() {
  return (
    <div className="guide-preview-project guide-slack-form">
      <div className="guide-preview-project-menu">
        <Row>
          <MoreHorizontal size={14} />
          <Label>A message’s menu</Label>
        </Row>
        <p>Copy link</p>
        <p>Save for later</p>
        <div className="guide-preview-divider" />
        <Label>Connect to apps</Label>
        <Row className="guide-slack-chosen">
          <strong>Send to MemCode</strong>
        </Row>
      </div>
      <ArrowRight className="guide-preview-connector" size={22} />
      <div className="guide-preview-panel">
        <Row>
          <strong>Send to MemCode</strong>
        </Row>
        {[
          ["What happened?", "Code blocks cut off long commands on phones."],
          ["What did you expect?", "You can scroll to the end of the command."],
          ["Where does it happen?", "The install page, any phone"],
          ["How bad is it?", "Annoying"],
        ].map(([question, answer]) => (
          <div key={question} className="guide-slack-field">
            <Label>{question}</Label>
            <span>{answer}</span>
          </div>
        ))}
        <Row className="guide-slack-send">
          <Files names={["mobile-review.pptx"]} />
          <span className="guide-preview-spacer" />
          <Action>Send</Action>
        </Row>
      </div>
    </div>
  );
}

function Evidence({ name, kind }: { name: string; kind: "image" | "document" | "sheet" }) {
  return (
    <div>
      <div className={`guide-preview-artifact-cover ${kind}`}>
        {kind === "image" ? (
          <div className="guide-slack-phone">
            <i />
            <span>k|</span>
          </div>
        ) : kind === "sheet" ? (
          <div className="guide-preview-sheet">
            {["Device", "Search", "iPhone", "Blank", "iPad", "Blank", "Pixel", "Works"].map(
              (cell, index) => (
                <span key={index}>{cell}</span>
              ),
            )}
          </div>
        ) : (
          <>
            <strong>Ticket 8812</strong>
            <i />
            <i />
            <i />
          </>
        )}
      </div>
      <strong>{name}</strong>
    </div>
  );
}

function InboxPreview() {
  return (
    <div className="guide-inbox">
      <div className="guide-inbox-list">
        <Row>
          <Inbox size={15} />
          <strong>Inbox</strong>
          <Label>New 3</Label>
        </Row>
        {[
          [title, "Dana · 4 files · 1 comment", "new comment"],
          ["Code blocks cut off long commands", "Lee · 2 files", ""],
          ["Copy a link to a heading", "Priya · 1 file", ""],
        ].map(([name, about, fresh], index) => (
          <div key={name} className={index === 0 ? "selected" : ""}>
            <strong>{name}</strong>
            <p>{about}</p>
            {fresh && <span className="guide-slack-app">{fresh}</span>}
          </div>
        ))}
      </div>
      <div className="guide-inbox-report">
        <Label>Dana Kowalski in #support</Label>
        <h4>{title}</h4>
        <p>Three customers wrote in about it today.</p>
        <div className="guide-preview-artifacts">
          <Evidence name="search-blank.png" kind="image" />
          <Evidence name="ticket-8812.pdf" kind="document" />
          <Evidence name="devices-tested.xlsx" kind="sheet" />
        </div>
        <div className="guide-preview-message">
          <Row>
            <MessageSquare size={13} />
            <strong>Sam Okafor</strong>
            <Label>Thread in Slack</Label>
          </Row>
          <p>Same on iPad. The devices we tried are in the sheet.</p>
        </div>
        <Row>
          <Action>Define a goal</Action>
          <Action quiet>Decline</Action>
        </Row>
      </div>
    </div>
  );
}

function GoalPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <div>
          <Label>New work · from a report</Label>
          <h4>The request is already written.</h4>
        </div>
        <Sparkles size={22} />
      </Row>
      <div className="guide-preview-composer guide-goal-request">
        <p>
          {title}. Three customers wrote in about it today.
          <br />
          <br />
          Comments in the thread:
          <br />- Sam Okafor: Same on iPad. The devices we tried are in the sheet.
        </p>
        <p className="yours">
          Fix it for iPhone and iPad, and add a check so it can’t come back.
          <span>You add this</span>
        </p>
      </div>
      <div className="guide-goal-files">
        {[
          ["slack-report.md", "The whole report"],
          ["search-blank.png", "What customers see"],
          ["devices-tested.xlsx", "Which devices we tried"],
        ].map(([name, note]) => (
          <div key={name}>
            <Row>
              <Paperclip size={12} />
              <strong>{name}</strong>
            </Row>
            <span>{note}</span>
          </div>
        ))}
      </div>
      <Row className="guide-preview-footnote">
        <span>Read it</span>
        <ArrowRight size={12} />
        <span>Say what the files show</span>
        <ArrowRight size={12} />
        <strong>Plan it</strong>
      </Row>
    </>
  );
}

function ProjectsPreview() {
  return (
    <>
      <Channel name="mobile-team">
        <Person name="Priya Shah" at="14:05">
          <p>
            <At /> The share button does nothing on Android tablets
          </p>
        </Person>
        <MemCodeSays at="14:05">
          <p>Which MemCode project is this for? This channel will remember.</p>
          <Row>
            <Action quiet>Lumen</Action>
            <Action quiet>Checkout</Action>
          </Row>
        </MemCodeSays>
      </Channel>
      <div className="guide-preview-callout">
        <Check size={18} />
        <div>
          <strong>Or name the project in the first message</strong>
          <p>
            <At /> Lumen: the install page still shows last year’s screenshots
          </p>
        </div>
      </div>
    </>
  );
}

const Key = ({ children }: { children: ReactNode }) => (
  <span className="tracked-key">
    <IntegrationMark id="linear" size={10} />
    {children}
  </span>
);

function LinearConnectPreview() {
  return (
    <>
      <Row className="guide-preview-section-heading">
        <div>
          <Label>Settings · Integrations</Label>
          <h4>Bring in the tools your team works in.</h4>
        </div>
      </Row>
      <div className="guide-integration-row">
        <span className="guide-integration-mark">
          <IntegrationMark id="linear" size={18} />
        </span>
        <div>
          <strong>Linear</strong>
          <p>Keep a team’s issues, goals and cycles in step with the board, both ways.</p>
        </div>
        <Action>Connect Linear</Action>
      </div>
      <Row className="guide-preview-cycle-flow">
        <span>Connect Linear</span>
        <ArrowRight size={13} />
        <span>Choose Authorize in your browser</span>
        <ArrowRight size={13} />
        <span>Choose a team</span>
      </Row>
      <div className="guide-preview-callout">
        <ShieldCheck size={18} />
        <div>
          <strong>From this computer, straight to Linear</strong>
          <p>
            Your sign-in stays in this computer’s credential store. Your code and your
            conversations are never sent.
          </p>
        </div>
      </div>
    </>
  );
}

function LinearImportPreview() {
  return (
    <div className="guide-preview-project guide-linear-import">
      <div className="guide-preview-panel">
        <Label>Bring work in</Label>
        {[
          ["From", "Web (WEB)"],
          ["Bring", "Open work, 24 issues"],
          ["Goals are", "Milestones, and projects without any"],
        ].map(([question, answer]) => (
          <div key={question} className="guide-slack-field">
            <Label>{question}</Label>
            <span>{answer}</span>
          </div>
        ))}
        <Row className="guide-slack-send">
          <span className="guide-preview-spacer" />
          <Action>Import 24 issues</Action>
        </Row>
      </div>
      <ArrowRight className="guide-preview-connector" size={22} />
      <div className="guide-linear-cards">
        {[
          ["WEB-41", "Keep an order’s status history", "Coupons · Checkout", "Planned"],
          ["WEB-42", "Cancel an order", "Coupons · Checkout", "In progress"],
          ["WEB-47", "Prices round wrong", "Checkout", "Planned"],
        ].map(([key, name, goal, lane]) => (
          <div key={key}>
            <Row>
              <Key>{key}</Key>
              <span className="guide-preview-spacer" />
              <Label>{lane}</Label>
            </Row>
            <strong>{name}</strong>
            <Label>{goal}</Label>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinearStepsPreview() {
  return (
    <div className="guide-linear-steps">
      <Row>
        <strong>In MemCode</strong>
        <span className="guide-preview-spacer" />
        <Key>WEB-41</Key>
        <span className="guide-preview-spacer" />
        <strong>In Linear</strong>
      </Row>
      {[
        ["A worker starts", "In Progress", false],
        ["The worker finishes", "In Review", false],
        ["The pull request opens", "Linked on the issue", false],
        ["The pull request merges", "Done", false],
        ["You raise the priority", "Urgent", false],
        ["“Keep the dates in UTC.”", "Dana comments", true],
      ].map(([here, there, back]) => (
        <div key={String(here)} className={back ? "back" : ""}>
          <span>{here}</span>
          <ArrowRight size={13} />
          <span>{there}</span>
        </div>
      ))}
      <Row className="guide-preview-footnote">
        <ArrowLeftRight size={12} />
        <span>Title, text, priority, people, labels, dates, cycle and goal go both ways</span>
      </Row>
    </div>
  );
}

function LinearApartPreview() {
  return (
    <>
      <div className="guide-preview-message guide-linear-apart">
        <Row>
          <Label>LINEAR</Label>
          <span className="guide-preview-spacer" />
          <span className="tracked-standing synced">In step</span>
        </Row>
        <Row>
          <Key>WEB-48</Key>
          <span>In Progress</span>
        </Row>
        <p>
          Title here was <q>Check addresses</q>
        </p>
        <Row>
          <Action quiet>Put it back</Action>
        </Row>
      </div>
      <div className="guide-preview-callout">
        <Check size={18} />
        <div>
          <strong>You wrote one title, Dana wrote another a minute later</strong>
          <p>
            Dana’s is newer, so both sides show “Check email addresses”. Yours is kept on the
            card.
          </p>
        </div>
      </div>
    </>
  );
}

export const integrationScenes: Record<string, () => ReactNode> = {
  linear: LinearConnectPreview,
  "linear-import": LinearImportPreview,
  "linear-steps": LinearStepsPreview,
  "linear-apart": LinearApartPreview,
  slack: ConnectPreview,
  "slack-report": ReportPreview,
  "slack-form": FormPreview,
  inbox: InboxPreview,
  "inbox-goal": GoalPreview,
  "slack-projects": ProjectsPreview,
};
