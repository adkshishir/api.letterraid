import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('LetterRaid API')
    .setDescription(
      'REST surface for LetterRaid — auth, ranked matchmaking, rooms, ' +
        'clans, tournaments and practice bots. Built for the upcoming ' +
        'mobile client.\n\n' +
        '**Gameplay itself is not REST.** Once a room is joined, everything ' +
        'about actually playing Heist — claiming words, the live pool, the ' +
        'clock, game-over — happens over a Socket.IO connection to the ' +
        '`/heist` namespace. That contract (event names, payload shapes, ' +
        'error codes) is documented separately in `docs/SOCKET_EVENTS.md` ' +
        'in this repo, not here.\n\n' +
        'Authenticate with `Authorization: Bearer <token>`, the same JWT ' +
        'returned by `POST /auth/verify-otp` and sent on every socket event too.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token from POST /auth/verify-otp — 30 day expiry.',
      },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: corsOrigins() });

  // No validation was enforced anywhere before this — every route relied on
  // ad-hoc manual checks in its service. `whitelist` strips unknown fields
  // instead of rejecting them, so an older mobile client sending an extra
  // field doesn't hard-break; `transform` lets a numeric field arrive as a
  // JSON number the way every existing caller already sends it.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  setupSwagger(app);

  const port = process.env.PORT ?? 5002;
  await app.listen(port);
  console.log(`LetterRaid backend running on http://localhost:${port}`);
  console.log(`API docs at http://localhost:${port}/api/docs`);
}
void bootstrap();
