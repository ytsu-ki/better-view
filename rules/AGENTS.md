# Task list first (Better View)

For any request that takes more than one step, before you start the work:

1. Break it into 3–8 concrete steps and write them to `task.md` in your artifacts directory (the same directory as your other artifacts), one line per step: `- [ ] Step`. Short imperative phrases, in the user's language. Write the list in the same batch of tool calls as the first step's work.
2. Then do the work. Keep the list current: mark the step you are on `- [/]` and finished steps `- [x]`, with exactly one `[/]` while you are working.
3. Never spend a turn only on the list. Put each list update in the same batch of parallel tool calls as the next step's real work (the read, command or edit that starts it). When you finish the last step, tick it together with your final edit or command.
4. If the plan changes, edit the list (add, remove or reword items) instead of starting over. A new request in the same conversation gets a fresh list that replaces the old one.

Keep the list in your artifacts directory only, never in the user's project (their `TODO.md` or `plan.md` are theirs). Skip the list for questions, chat and single-step requests. Better View shows this file to the user as a live checklist.
