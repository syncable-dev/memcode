# Beta.18 continuation and publication checks

The Mac acceptance report found first-review preparation failures and provider
continuations that created new native conversations. Keep the original beta.18
archives staged. The revised app needs packages and signatures for both platforms.

The Windows integration preserves the Mac fixes through `d087c05`. It also binds
native history to the provider, physical checkout, epic and branch; keeps automatic
continuations with their original provider; and avoids replaying the saved
transcript into an already resumed conversation. Cursor uses native resume when
advertised, otherwise its supported ACP load flow. Failed resume never silently
creates a replacement conversation.

The native `index_verification_running` response now gets a bounded wait for the
same source certificate. This is progress, not a successful review. Captured
worker edits retain the Mac fix's bounded refresh path. Foreign graphs, changed
source and partial certificates remain rejected.

Windows validation on 19 November:

- All 903 unit tests passed; typecheck and the renderer/runtime build passed.
- Real installed Codex (`gpt-6-luna`), Claude Code (`claude-sonnet-5-5`) and Cursor
  (`composer-2.5`) each edited a disposable source file. An independent Node
  assertion checked the result. Each then recovered a random tag supplied only
  in its first turn, using the same native session in a new provider process.
  The two-turn runs took 21.1, 35.0 and 36.1 seconds respectively.
- Those native adapter checks used explicit Full access in disposable checkouts.
  They do not establish graph performance, Smart auto support or two-device
  acceptance. Cursor ACP still does not support Smart auto.
- The actual Windows packaged QA app received three Mac-owned stories, with
  confirmed models, attributed conversation and execution location. A Windows
  follow-up was received and queued by the Mac. Completion, queue editing,
  cancellation and shared review acceptance remain to be confirmed on both
  physical devices with the final packages.

Run `node --import tsx scripts/verify-native-continuity.mts` explicitly to repeat
the real-provider check. It uses installed authenticated harnesses and can spend
their model credits. Set `QA_HARNESS` for one provider and
`QA_CONTINUITY_OUTPUT` for its JSON receipt. It does not modify a personal board.

The Mac must rebuild the integrated source and repeat first-review preparation,
Improve refresh, exact MC-039 values and native continuation. Both new archives
then need version-bound production updater signatures. None of these checks
authorizes publishing an older archive or treating missing evidence as zero.
