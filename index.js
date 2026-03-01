require('dotenv').config();
const { App } = require('@slack/bolt');
const { genkit, z } = require('genkit');
const { googleAI } = require('@genkit-ai/googleai');

// Initialize the Slack Bolt App
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Initialize Genkit
const ai = genkit({
  plugins: [googleAI()],
  model: 'googleai/gemini-3.1-pro-preview', // Fixed model string
});

// Create a Genkit flow
const chatFlow = ai.defineFlow({
  name: 'chatFlow',
  inputSchema: z.string(),
  outputSchema: z.string(),
}, async (message) => {
  const { text } = await ai.generate({
    prompt: message,
    model: 'googleai/gemini-3.1-pro-preview'
  });
  return text;
});

// Add app_mention event listener
app.event('app_mention', async ({ event, context, client, say }) => {
  let placeholderTs;

  try {
    // Initial Acknowledgment: Immediately upon receiving the event
    await client.reactions.add({
      channel: event.channel,
      name: 'eyes',
      timestamp: event.ts
    });

    // Post Placeholder
    const placeholderMessage = await say({
      text: '🧠 Processing your request...',
      thread_ts: event.ts
    });
    placeholderTs = placeholderMessage.ts;

    // Extract the text, removing the bot mention at the start
    const textWithoutMention = event.text.replace(/<@.+?>/, '').trim();

    // Process AI Generation: Await the Genkit flow
    const aiResponse = await chatFlow(textWithoutMention);

    // Update UI: Overwrite the placeholder message with final AI response
    // Slack has a 4000 character limit per message, so we chunk to be safe.
    const textLimit = 3000;
    if (aiResponse.length <= textLimit) {
      await client.chat.update({
        channel: event.channel,
        ts: placeholderTs,
        text: aiResponse
      });
    } else {
      // Split into safe chunk sizes
      const chunks = [];
      for (let i = 0; i < aiResponse.length; i += textLimit) {
        chunks.push(aiResponse.substring(i, i + textLimit));
      }

      // Update the placeholder with the first chunk
      await client.chat.update({
        channel: event.channel,
        ts: placeholderTs,
        text: chunks[0]
      });

      // Send the rest as sequential replies in that thread
      for (let i = 1; i < chunks.length; i++) {
        await say({
          text: chunks[i],
          thread_ts: event.ts
        });
      }
    }

    // Update Emojis: Remove eyes, add white_check_mark
    await client.reactions.remove({
      channel: event.channel,
      name: 'eyes',
      timestamp: event.ts
    });
    await client.reactions.add({
      channel: event.channel,
      name: 'white_check_mark',
      timestamp: event.ts
    });

  } catch (error) {
    console.error('Error handling app_mention event:', error);

    if (placeholderTs) {
      try {
        // Update the placeholder text to indicate an error
        await client.chat.update({
          channel: event.channel,
          ts: placeholderTs,
          text: '❌ Sorry, I encountered an error processing that.'
        });
      } catch (e) {
        console.error('Failed to update placeholder with error message:', e);
      }
    }

    try {
      // Remove the eyes emoji
      await client.reactions.remove({
        channel: event.channel,
        name: 'eyes',
        timestamp: event.ts
      });
    } catch (e) {
      console.error('Failed to remove eyes emoji:', e);
    }

    try {
      // Add the x emoji
      await client.reactions.add({
        channel: event.channel,
        name: 'x',
        timestamp: event.ts
      });
    } catch (e) {
      console.error('Failed to add x emoji:', e);
    }
  }
});

// Start the app locally
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Bolt app is running on port ${port}`);
})();
