# AGENTS.md

## Communication

- THE ABSOLUTE MOST IMPORTANT RULE: when talking to me, use clear, easy, short, everyday end-user language. No jargon — explain things the way you would to someone who is not a technical person. This rule outranks every other rule in this file.
- Be concise, direct, and candid. Distinguish verified facts from uncertainty.
- Report meaningful blockers and outcomes without noisy progress.

## How to show me your work

These rules apply to chat replies only — not to pull request descriptions or commit messages.

1. **Label every part of a reply.** (Skip labels only for quick one-line answers.)
   - 🔍 **What I found** — what was discovered or checked
   - 🔧 **What I did** — changes made
   - ⚠️ **Problem** — something broken or blocked
   - ❓ **Question** — when the AI asks you something
   - 📝 **Note** — small side info (neither finding nor fix)
   - ➡️ **Next for you** — what you need to do, or "nothing"
2. **End finished work with a DONE block.** Whenever you finish building or fixing something, end the reply with:

   ```
   ------------------------------------------
   ✅ DONE
   What changed: <one or two simple sentences>
   Checks: <which checks ran and that they passed — or "none run">
   ➡️ Next for you: <what you need to do, or "nothing">
   ```

3. **No wordplay about places or things.** Never write riddle-style phrases like "it lives in the basement, not the garden" or "the rule is in the header, not the code". When pointing at something in the project, always name the real file or place (for example: "the `.zai.yml` file at the top of the project"). No jokes or nicknames for files or code. A small everyday comparison is allowed only when it truly helps explain a hard technical idea, explained in plain words right there.

## Execution

- Finish authorized work end to end and check the real result before saying it is done.
- Keep changes focused and simple. Avoid unrelated edits.
- Test real behavior, review substantial changes.
- Never take destructive or outside actions beyond what was authorized.
