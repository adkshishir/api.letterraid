import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Comma-separated list, e.g. "https://letterraid.com,https://www.letterraid.com".
// Kept in env rather than hardcoded (imposter hardcodes its origin list, which
// means a code change every time a domain moves) — LetterRaid's domain isn't
// live yet, so this has to stay swappable.
const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://localhost:4041'];

function corsOrigins(): string[] {
  const fromEnv = process.env.CORS_ORIGINS;
  if (!fromEnv) return DEFAULT_ORIGINS;
  return fromEnv
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: corsOrigins() });

  const port = process.env.PORT ?? 4042;
  await app.listen(port);
  console.log(`LetterRaid backend running on http://localhost:${port}`);
}
void bootstrap();
