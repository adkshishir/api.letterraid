module.exports = {
  apps: [
    {
      name: 'api.letterraid',
      script: 'npm',
      args: 'run start:prod',
      env: {
        NODE_ENV: 'production',
        // 5004 — portfolio holds 5000, twofaced holds 5001/5002 on the same
        // box.
        PORT: 5004,
        // Interim test domain. Swap this when letterraid.com goes live; the
        // backend reads it at runtime, so it only needs a pm2 restart (the
        // frontend, by contrast, must be rebuilt — see its config).
        CORS_ORIGINS: 'https://letterraid.adhikarishishir.com.np',
      },
    },
  ],
};
