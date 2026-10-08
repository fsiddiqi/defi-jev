// PM2 process definition for defi-jev.
//
//   npm run start     # pm2 start ecosystem.config.cjs
//   npm run stop      # pm2 stop defi-jev
//   npm run restart   # pm2 restart defi-jev
//   npm run logs      # pm2 logs defi-jev
//
// Auto-start on boot (one time, needs sudo):
//   npx pm2 start ecosystem.config.cjs
//   npx pm2 save
//   npx pm2 startup            # prints/runs the systemd unit; re-run the printed command with sudo
module.exports = {
  apps: [
    {
      name: "defi-jev",
      cwd: __dirname,
      // tsx CLI executed by node (the repo is ESM, and main.ts is TypeScript).
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/main.ts",
      interpreter: "node",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "30s",
      restart_delay: 5000,
      kill_timeout: 15000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};