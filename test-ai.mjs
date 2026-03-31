import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function testAI(modelName) {
    try {
        console.log(`Testing ${modelName}:`);
        const res = await ai.models.generateContent({
            model: modelName,
            contents: "Hi, reply exactly with 'OK'."
        });
        console.log(`Success ${modelName}:`, res.text);
    } catch (err) {
        console.error(`Failed ${modelName}:`, err.message);
    }
}

async function run() {
    await testAI("gemini-1.5-flash");
    await testAI("gemini-1.5-pro-latest");
    await testAI("gemini-2.0-flash");
    await testAI("gemini-2.5-flash");
    await testAI("gemini-3-flash-preview");
}
run();
