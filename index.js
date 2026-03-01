require('dotenv').config();
const { App } = require('@slack/bolt');
const { genkit, z } = require('genkit');
const { googleAI } = require('@genkit-ai/googleai');
const axios = require('axios');
const cheerio = require('cheerio');
const { YoutubeTranscript } = require('youtube-transcript');

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

// Create Genkit tools
const scrapeWebpage = ai.defineTool({
  name: 'scrapeWebpage',
  description: 'Fetches the textual content of a webpage given its URL.',
  inputSchema: z.object({ url: z.string() }),
  outputSchema: z.object({ text: z.string() })
}, async ({ url }) => {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    $('script, style').remove();
    let text = $('body').text() || $('article').text() || '';
    // Clean up excessive whitespace
    text = text.replace(/\s+/g, ' ').trim();
    return { text: text.substring(0, 15000) };
  } catch (error) {
    console.error('Error in scrapeWebpage:', error);
    return { text: `Failed to scrape webpage: ${error.message}` };
  }
});

const getYouTubeTranscript = ai.defineTool({
  name: 'getYouTubeTranscript',
  description: 'Fetches the transcript of a YouTube video given its URL.',
  inputSchema: z.object({ url: z.string() }),
  outputSchema: z.object({ text: z.string() })
}, async ({ url }) => {
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(url);
    const text = transcript.map(t => t.text).join(' ');
    return { text };
  } catch (error) {
    console.error('Error in getYouTubeTranscript:', error);
    return { text: `Failed to fetch transcript: ${error.message}` };
  }
});

// Create a Genkit flow
const chatFlow = ai.defineFlow({
  name: 'chatFlow',
  inputSchema: z.string(),
  outputSchema: z.string(),
}, async (message) => {
  const { text } = await ai.generate({
    prompt: message,
    model: 'googleai/gemini-3.1-pro-preview',
    tools: [scrapeWebpage, getYouTubeTranscript],
    system: 'If the user provides a URL or a YouTube link, you MUST use your tools to fetch the content before summarizing it or answering questions about it.'
  });
  return text;
});

// Add app_mention event listener
app.event('app_mention', async ({ event, context, client, say }) => {
  let placeholderTs;

  try {
    // Initial Acknowledgment: Immediately upon receiving the event
    try {
      await client.reactions.add({
        channel: event.channel,
        name: 'eyes',
        timestamp: event.ts
      });
    } catch (e) {
      if (e.data && e.data.error !== 'already_reacted') {
        throw e;
      }
    }

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
    try {
      await client.reactions.remove({
        channel: event.channel,
        name: 'eyes',
        timestamp: event.ts
      });
    } catch (e) {
      if (e.data && e.data.error !== 'no_reaction') {
        console.error('Failed to remove eyes emoji:', e);
      }
    }

    try {
      await client.reactions.add({
        channel: event.channel,
        name: 'white_check_mark',
        timestamp: event.ts
      });
    } catch (e) {
      if (e.data && e.data.error !== 'already_reacted') {
        console.error('Failed to add checkmark emoji:', e);
      }
    }

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
      if (e.data && e.data.error !== 'no_reaction') {
        console.error('Failed to remove eyes emoji:', e);
      }
    }

    try {
      // Add the x emoji
      await client.reactions.add({
        channel: event.channel,
        name: 'x',
        timestamp: event.ts
      });
    } catch (e) {
      if (e.data && e.data.error !== 'already_reacted') {
        console.error('Failed to add x emoji:', e);
      }
    }
  }
});

app.event('message', async ({ event, context, client }) => {
  try {
    // Filter: Check if event.subtype === 'message_changed' and not bot
    if (event.subtype !== 'message_changed' || !event.message || event.message.user === context.botUserId) {
      return;
    }

    // Mention Check: Check if edited text contains bot ID
    const editedText = event.message.text || '';
    if (!editedText.includes(`<@${context.botUserId}>`)) {
      return;
    }

    // Locate Previous Answer: Fetch thread replies
    const threadTs = event.message.thread_ts || event.message.ts;
    const repliesResult = await client.conversations.replies({
      channel: event.channel,
      ts: threadTs
    });

    let botMessageToUpdate;
    if (repliesResult.messages) {
      // Find the first bot message that appears after the edited message chronologically
      botMessageToUpdate = repliesResult.messages.find(msg =>
        msg.user === context.botUserId && parseFloat(msg.ts) > parseFloat(event.message.ts)
      );
    }

    // UI State (Processing)
    if (botMessageToUpdate) {
      try {
        await client.reactions.add({
          channel: event.channel,
          name: 'eyes',
          timestamp: event.message.ts
        });
      } catch (e) {
        if (e.data && e.data.error !== 'already_reacted') {
          console.error('Failed to add eyes emoji:', e);
        }
      }

      await client.chat.update({
        channel: event.channel,
        ts: botMessageToUpdate.ts,
        text: '🧠 Processing your updated request...'
      });

      try {
        // Generate & Final Update: Await Genkit flow with new text
        const textWithoutMention = editedText.replace(/<@.+?>/g, '').trim();
        const aiResponse = await chatFlow(textWithoutMention);

        // Handle Slack's character limit by chunking if necessary
        const textLimit = 3000;
        if (aiResponse.length <= textLimit) {
          await client.chat.update({
            channel: event.channel,
            ts: botMessageToUpdate.ts,
            text: aiResponse
          });
        } else {
          const chunks = [];
          for (let i = 0; i < aiResponse.length; i += textLimit) {
            chunks.push(aiResponse.substring(i, i + textLimit));
          }

          await client.chat.update({
            channel: event.channel,
            ts: botMessageToUpdate.ts,
            text: chunks[0]
          });

          // Send the rest as sequential replies in that thread
          for (let i = 1; i < chunks.length; i++) {
            await client.chat.postMessage({
              channel: event.channel,
              text: chunks[i],
              thread_ts: threadTs
            });
          }
        }

        // Final UI: Remove eyes emoji, add checkmark
        try {
          await client.reactions.remove({
            channel: event.channel,
            name: 'eyes',
            timestamp: event.message.ts
          });
        } catch (e) {
          if (e.data && e.data.error !== 'no_reaction') {
            console.error('Failed to remove eyes emoji:', e);
          }
        }

        try {
          await client.reactions.add({
            channel: event.channel,
            name: 'white_check_mark',
            timestamp: event.message.ts
          });
        } catch (e) {
          if (e.data && e.data.error !== 'already_reacted') {
            console.error('Failed to add checkmark emoji:', e);
          }
        }
      } catch (generationError) {
        console.error('Error during AI generation for message_changed:', generationError);
        // Fallback UI update on error
        try {
          await client.chat.update({
            channel: event.channel,
            ts: botMessageToUpdate.ts,
            text: '❌ Sorry, I encountered an error processing your update.'
          });
        } catch (e) {
          console.error('Failed to update bot message with error text:', e);
        }

        try {
          await client.reactions.remove({
            channel: event.channel,
            name: 'eyes',
            timestamp: event.message.ts
          });
        } catch (e) {
          if (e.data && e.data.error !== 'no_reaction') {
            console.error('Failed to remove eyes emoji:', e);
          }
        }

        try {
          await client.reactions.add({
            channel: event.channel,
            name: 'x',
            timestamp: event.message.ts
          });
        } catch (e) {
          if (e.data && e.data.error !== 'already_reacted') {
            console.error('Failed to add x emoji:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error handling message_changed event:', error);
  }
});

// Start the app locally
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Bolt app is running on port ${port}`);
})();
