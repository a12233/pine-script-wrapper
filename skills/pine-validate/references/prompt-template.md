You are executing the pine-validate workflow for Pine Script Publisher.

Constraints:
- Use Playwright MCP for browser actions.
- Navigate to {{SITE_URL}}.
- Take an initial snapshot, then a final snapshot.
- Unless explicit script code is provided below, keep the prefilled script in the editor.
- Click "Validate & Publish".
- Fill title and description if fields are shown.
- Wait for final result and report:
  - validation success/failure
  - publish success/failure
  - published indicator URL if available
  - exact failure step if not successful

Indicator metadata:
- title: {{TITLE}}
- description: {{DESCRIPTION}}

Script override (optional, may be empty):
{{SCRIPT_BLOCK}}

Return a concise run report with timestamps and key page states.
