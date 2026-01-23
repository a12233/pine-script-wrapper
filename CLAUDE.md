# Development Workflow

## Deployment
- This project deploys to **Fly.io**
- Use `fly logs` (streaming) to tail logs in real-time - **prefer this over chunked fetches**
- Use `fly logs --no-tail` only for quick snapshots
- Use `fly status` to check app status
- Use `fly deploy` to deploy manually

## Branch Strategy
- Work in feature branches: `feat/<feature-name>`
- Never commit directly to `master`
- Create PRs to merge completed features into `master`

## PR Process
When a feature is complete:
1. Ensure all changes are committed to the feature branch
2. Push the branch to origin
3. Create a PR targeting `master`
4. Include a summary of changes in the PR description

## Historical Context
Daily development notes are stored in `~/notes/` (format: `YYYY-MM-DD.md`).
Project-specific notes: `~/notes/pine-script-wrapper/`

Reference these notes for:
- Prior decisions and rationale
- Setup changes and configurations
- Completed tasks and their context
