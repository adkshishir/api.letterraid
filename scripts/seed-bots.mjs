/**
 * Seeds (or refreshes) the fallback bot roster the matchmaker picks from when
 * solo queue times out with no human opponent — see `BOT_FALLBACK_MS` in
 * `src/match/matchmaker.service.ts`.
 *
 * Idempotent and safe to re-run: each bot has a fixed, stable `id` (not the
 * default `cuid()`), so this always upserts the same ~8-10 rows and never
 * touches any other `Player` row. Run from the backend root:
 *
 *     npm run seed:bots
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Trophies span roughly 0-2000 in ~230-step bands so every rank tier in the
 * matchmaker's fallback (see `pickBot`) has a plausible-looking opponent
 * nearby. Names are heist/word-themed but read as a name, not a joke — a
 * player who loses to one shouldn't feel like the game winked at them.
 */
const BOTS = [
  { id: 'bot-copper-raider', displayName: 'Copper Raider', trophies: 0 },
  { id: 'bot-iron-fox', displayName: 'Iron Fox', trophies: 230 },
  { id: 'bot-vault-ghost', displayName: 'Vault Ghost', trophies: 460 },
  { id: 'bot-silent-lexicon', displayName: 'Silent Lexicon', trophies: 690 },
  { id: 'bot-midnight-scribe', displayName: 'Midnight Scribe', trophies: 920 },
  { id: 'bot-cipher-jackal', displayName: 'Cipher Jackal', trophies: 1150 },
  { id: 'bot-golden-heist', displayName: 'Golden Heist', trophies: 1380 },
  { id: 'bot-platinum-wordsmith', displayName: 'Platinum Wordsmith', trophies: 1610 },
  { id: 'bot-obsidian-raven', displayName: 'Obsidian Raven', trophies: 1840 },
  { id: 'bot-diamond-cracker', displayName: 'Diamond Cracker', trophies: 2000 },
];

async function main() {
  for (const bot of BOTS) {
    await prisma.player.upsert({
      where: { id: bot.id },
      create: {
        id: bot.id,
        displayName: bot.displayName,
        email: null,
        isBot: true,
        trophies: bot.trophies,
      },
      update: {
        displayName: bot.displayName,
        isBot: true,
        // Trophies drift naturally from real wins/losses once seeded — only
        // set them here on first insert, never stomp them on a re-run.
      },
    });
    console.log(`Seeded bot: ${bot.displayName} (${bot.trophies} trophies)`);
  }

  const count = await prisma.player.count({ where: { isBot: true } });
  console.log(`Bot roster ready: ${count} bot player(s) in the database.`);
}

main()
  .catch((err) => {
    console.error('Failed to seed bot roster', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
