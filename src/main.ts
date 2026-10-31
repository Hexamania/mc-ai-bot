/**
 * Development entry point for mc-ai-bot
 * Run with: npx tsx src/main.ts
 */

import { createApp } from './index';

async function main(): Promise<void> {
  try {
    await createApp();

    // Keep the process alive
    console.log('[MAIN] Application running. Press Ctrl+C to stop.');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n[MAIN] Shutting down...');
      process.exit(0);
    });
  } catch (error) {
    console.error('[MAIN] Failed to start:', error);
    process.exit(1);
  }
}

void main();
