# Contributing

Thank you for helping. Issues and pull requests are welcome at <https://github.com/TicketWaveHQ/static-csp>.

## Ground rules

- **No dependencies.** The package uses Node.js built-ins only, and that is part of what it offers. A change that needs a dependency should start as an issue.
- **Node.js 20 or later.** Do not use APIs newer than Node.js 20.
- **Tests run offline** with `node:test`: `npm test`. Every change to what is hashed, refused or written needs a test, and a parser change should say which part of the HTML Standard or the CSP specification it follows.
- **Fail closed.** When the tool cannot be sure a page is safe to ship (an attribute it cannot account for, a configuration it does not understand), it should fail with a clear message rather than guess.
- **Messages name the fix.** An error says what was found, where (`file:line:column`), and what to do instead.

## Writing

Documentation and messages are in UK English. Do not use em-dashes; use a comma, a colon, or a full stop. State only what you have checked: if a claim depends on browser behaviour, link to the specification or test it.

## Pull requests

1. Fork, and branch from `main`.
2. Make the change, with tests and a line in `CHANGELOG.md` under "Unreleased".
3. Run `npm test`.
4. Open the pull request with a short description of the problem it solves.

By contributing you agree that your contribution is licensed under the MIT License in [LICENSE](LICENSE).
