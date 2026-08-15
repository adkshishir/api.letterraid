module.exports = {
  apps: [
    {
      name: 'api.letterraid',
      script: 'npm',
      args: 'run start:prod',
      env: {
        NODE_ENV: 'production',
        // 4042 — imposter holds 4021/4022 and Cahoots holds 4031/4032 on the
        // same box.
        PORT: 4042,
        // Interim test domain. Swap this when letterraid.com goes live; the
        // backend reads it at runtime, so it only needs a pm2 restart (the
        // frontend, by contrast, must be rebuilt — see its config).
        CORS_ORIGINS: 'https://letterraid.adhikarishishir.com.np',
      },
    },
  ],
};
