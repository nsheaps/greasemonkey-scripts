# Greasemonkey Scripts

A collection of user scripts for various websites, built with TypeScript and managed as a monorepo.

## Project Structure

This repository uses a monorepo structure with the following setup:

- Yarn workspaces for package management
- NX for build orchestration
- TypeScript for development
- Changesets for version management
- oxlint for linting
- GitHub Actions for CI/CD

## Getting Started

1. Install Node.js using nvm:

   ```bash
   nvm install
   nvm use
   ```

2. Enable corepack for package manager management:

   ```bash
   corepack enable
   ```

3. Install dependencies:

   ```bash
   yarn install
   ```

4. Build the project:
   ```bash
   yarn build
   ```

## Development

- Each script is a separate package in the `packages/` directory
- Use `yarn changeset` to create a new changeset
- Use `yarn changeset version` to version packages
- Use `yarn changeset publish` to publish packages

## Scripts

Each script is published to [GreasyFork](https://greasyfork.org/en/scripts?by=1372068) automatically when a new release is created.

## License

MIT
