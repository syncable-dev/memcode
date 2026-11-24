# The Inbox: reports from Slack

A project has an Inbox. People report problems in Slack, with screenshots, recordings, PDFs,
logs and links, and the reports land here. Nothing is added to the board until someone picks
a report up, and no AI reads them on the way. It works the same whether you build alone or
share the project with a team.

## Connect Slack

1. Open the project, then **Settings › Integrations** and choose **Slack**.
2. Choose **Add to Slack**. Slack opens in your browser: choose **Allow**.
3. The Slack page in MemCode turns **Connected** within a few seconds.

That connects the whole Slack workspace to the project. There is nothing to set up per
channel.

You need to be signed in to Memtrace, and the project does not have to be shared. Slack
cannot reach your computer, so reports and their files wait on MemSync, Memtrace's sharing
service, where they arrive even while MemCode is closed. On a project that is not shared,
only you can see them there, and your board and code stay on your computer. If you share the
project later, the Inbox and its Slack connection become the shared project's. Deleting the
project deletes its Inbox too.

**Disconnect** on the same page stops the workspace, and every channel in it, sending
reports to the project.

## Report something from Slack

- **Mention @MemCode** in a message. It goes to the Inbox as written, with its files and
  links. In a thread, the thread's first message is sent, with what you wrote added to it as
  a comment. Mention @MemCode there again to add another comment, with its files.
- **Send to MemCode**, in a message's ⋯ menu under **Connect to apps**, opens a short form:
  what happened, what you expected, where it happens, how bad it is, and more files.

MemCode answers in the thread: "Added to *Project* › Inbox: “…”". The first time someone
mentions @MemCode in a channel, Slack offers to add it to that channel: choose **Add**.

Anyone in the workspace can report, even if they are not on the project. Reports are
written as the person who connected the workspace, and each one names who wrote it.

When a workspace is connected to several projects, a message that names one, such as
"@MemCode Checkout: …", goes there. Otherwise MemCode asks once in the thread which
project it is for, and that channel remembers the answer.

## Pick a report up

Open **Inbox**. The report last written about is listed first, and new comments are marked.
Open one to see what happened, the evidence, the links and the comments. Then:

- **Define a goal** opens New work with the report and its comments already written in, and
  every file attached. Say what the files show, and plan it. The workers get all of it:
  see [files in conversations and new work](attachments.md). The report is marked picked up
  and linked to the goal.
- **Decline** says why it will not be done. **Reopen** puts it back.

Every file shows a small preview. A click opens pictures, recordings, PDF, Word, Excel,
PowerPoint and text files inside MemCode. **Open on this computer** uses the program you
normally open that kind of file with. Files that can run, such as programs and web pages,
open in Slack only.

Files up to 5 MB are kept with the project. Bigger ones stay in Slack and the report links
to them. The Inbox looks for new reports every 15 seconds while it is open.

The sharing service has to offer Slack for any of this. An older service shows "does not
offer Slack yet" on the Slack page, and the Inbox still lists what is there.
