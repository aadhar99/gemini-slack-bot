require('dotenv').config();
const { genkit, z } = require('genkit');
const { googleAI } = require('@genkit-ai/googleai');

const ai = genkit({
    plugins: [googleAI()],
    model: 'googleai/gemini-3.1-pro-preview',
});

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

async function run() {
    try {
        console.log("Testing Genkit flow...");
        const aiResponse = await chatFlow("Hello, are you there?");
        console.log("Success:", aiResponse);
    } catch (e) {
        console.error("Genkit Error:", e);
    }
}

run();
