require('dotenv').config();
const { App } = require('@slack/bolt');
const { genkit, z } = require('@genkit-ai/core');
const { googleAI } = require('@genkit-ai/googleai');

// Initialize the Slack Bolt App
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Initialize Genkit
const ai = genkit({
  plugins: [googleAI()],
  model: 'gemini-3.1-pro', // Configuring it to use gemini-3.1-pro as requested
});

// Create a Genkit flow
const chatFlow = ai.defineFlow({
  name: 'chatFlow',
  inputSchema: z.string(),
  outputSchema: z.string(),
}, async (message) => {
  const { text } = await ai.generate({
    prompt: message,
    model: 'gemini-3.1-pro'
  });
  return text;
});

// Add app_mention event listener
app.event('app_mention', async ({ event, context, client, say }) => {
  try {
    // Extract the text, removing the bot mention at the start
    const textWithoutMention = event.text.replace(/<@.+?>/, '').trim();
    
    // Pass the message to the Genkit flow
    const aiResponse = await chatFlow(textWithoutMention);

    // Reply in the Slack thread
    await say({
      text: aiResponse,
      thread_ts: event.ts
    });
  } catch (error) {
    console.error('Error handling app_mention event:', error);
  }
});

// Start the app locally
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Bolt app is running on port ${port}`);
})();
