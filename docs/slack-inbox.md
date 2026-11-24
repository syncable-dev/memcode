# The Inbox: reports from Slack

A shared project has an Inbox. People on your team report problems in Slack, with
screenshots, recordings, PDFs, logs and links, and the reports land here. Nothing is added
to the board until someone picks a report up. No AI reads them on the way.

## Link a Slack channel

1. In the Slack channel, type `/memcode link`. Slack shows a code, such as `ABCD-EFGH`, that
   works once for 15 minutes.
2. In MemCode, open the shared project, choose **Inbox**, and enter the code under
   **Link a Slack channel**.

The channel then says it sends reports to the project. Anyone in that channel can report,
even if they are not on the project. Reports are written as the person who linked the
channel, and each one names who wrote it. If that person leaves the project, the channel
stops sending reports until someone links it again.

The MemCode app has to be added to the Slack workspace first. Whoever runs the sharing
service does that once.

## Report something from Slack

- Mention @MemCode in a message. Its files come with it.
- Choose **Send to MemCode** in a message's menu to add what you expected, where it happens,
  how bad it is, and more files.
- React with 📥 to send someone else's message.

Mentioning @MemCode in a thread sends the thread's first message, with what you wrote.

## Pick a report up

Open **Inbox**. New reports are listed first. Open one to see what happened, the evidence
and the links. Then:

- **Define a goal** opens New work with the report already written in. Write the goal the
  way you want to solve it, or let your own connected tool draft it. The report is marked
  picked up and linked to the goal.
- **Decline** says why it will not be done. **Reopen** puts it back.

Files up to 5 MB are kept with the project. Bigger ones stay in Slack and the report links
to them. The Inbox looks for new reports every 15 seconds while it is open.
