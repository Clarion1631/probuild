require('dotenv').config({ path: '.env.local' });
const { GoogleGenAI } = require("@google/genai");

async function test() {
    console.log("Testing GenAI API call...");
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
        });
        console.log("Success:", response.text);
    } catch (e) {
        console.error("Failed:", e.message || e);
    }
}

test();
