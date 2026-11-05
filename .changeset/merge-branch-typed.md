---
"kai-terminal": patch
---

The Merge branch is typed, not picked from a loaded list.

- **No branch list**: opening **More** on the Azure DevOps card no longer fetches the repository's branches. **Merge branch** is a text box; leave it empty for the repository's default branch.
- **A wrong name is refused clearly**: **Save** checks that one name and says `The repository has no branch named "x"` (names are case-sensitive). Opening a pull request does the same for both the source and the target branch, before anything is created: `The source branch "x" does not exist in api` / `The target branch "x" does not exist in api`. If the repository cannot be reached, a typed merge branch is still saved.
- **One "Connected" heading**: the Azure DevOps card heading says `Connected` instead of `Active for this project`, so "active" is not repeated; the project in use is shown on its own line below.
- **No refresh buttons**: the Azure DevOps and Microsoft Teams cards no longer have a circular refresh button. They re-read their status when you open the tab and whenever the window regains focus.
- **Simpler card**: no **Switch project** button (the project comes from the git remote; **Choose project** remains for a folder without one). The active account is marked **Active** in its row, with **Make active** on the others. The second sign-in button is **Add account**. Shorter text throughout: the intro, the card descriptions and the sign-in waiting message.
- **Long branch naming patterns**: the pattern field is now a box that wraps and grows with the text (a few lines, then it scrolls) with a live `n / 200` count that turns amber near the limit and red over it. A longer pattern is never cut off: it is marked, explained and cannot be saved. Line breaks cannot be typed or pasted.
