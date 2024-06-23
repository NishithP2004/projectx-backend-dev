const {
    app
} = require('@azure/functions');
const getDocumentContent = require('./courses-doc-content');
require('dotenv').config({
    path: ".env"
});
const admin = require('firebase-admin');

// -- Models --
const { AzureOpenAI } = require("openai")

const model = new AzureOpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    endpoint: process.env.AZURE_OPENAI_API_ENDPOINT
})
// -- Models -- 

async function createQuiz(content, questions = 1) {
    try {
        const modelName = "gpt-4-32k"

        const prompt = `
                        You are an expert in creating quizzes based on YouTube video transcripts or document summaries. 
                        Your task is to generate insightful questions with four possible answers from the provided content. 
                        Each question should have one or more correct answers, while the other options may or may not be related terms. 
                        The purpose is to assess the user's comprehension of the material, ensuring that the answer can be inferred from the provided transcript or summary.
                        The response should be in JSON format as follows:
                        {
                        "quiz": [
                            {
                            "question": "Your question here...",
                            "answers": [
                                "Option 1",
                                "Option 2",
                                "Option 3",
                                "Option 4"
                            ],
                            "answerSelectionType": "single|multiple",
                            "explanation": "Explanation of the correct answer...",
                            "correctAnswer": "correctAnswerOptionNumber" || [array of correct answer option numbers] // [1, 2, 3, 4]
                            }
                            // Additional questions here...
                        ]
                        }

                        Ensure the questions are authentic and accurately reflect the content.
                    `
        // let res = await model.call(prompt);
        /* let res = (await model.invoke([
            ["human", prompt]
        ])).content
        console.log(res)

        return JSON.parse(res); */
        let res = await model.chat.completions.create({
            messages: [
                {
                    "role": "system",
                    "content": prompt
                },
                {
                    "role": "user",
                    "content": content
                },
                {
                    "role": "user",
                    "content": `Generate a set of ${questions} question(s) and return the same as an array of JSON objects`
                }
            ],
            model: modelName,
            response_format: {
                type: "json_object"
            },
            temperature: 0.7
        })
        console.log((res.choices[0].message.content))
        return JSON.parse(res.choices[0].message.content);
    } catch (err) {
        if (err) {
            console.error(err);
            return null;
        }
    }
}

app.http('quiz', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);

        if (request.method == "GET") {
            return {
                body: JSON.stringify({
                    message: "Hello World"
                }),
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        } else {
            const body = await request.json();

            let token = request.headers.get("Authorization");
            let content = body.transcript || body.summary;
            let questions = body.questions || 1;
            let doc_id = body.doc_id;

            questions %= 11;

            let status = 200,
                res;

            if ((token && doc_id) || (token && content)) {
                token = token.split(" ")[1].trim();
                try {
                    let user = await admin.auth().verifyIdToken(token)
                        .catch(err => {
                            if (err) {
                                status = 403;
                                res = {
                                    success: false,
                                    error: "Forbidden"
                                }

                                return {
                                    body: JSON.stringify(res),
                                    status,
                                    headers: {
                                        'Content-Type': 'application/json'
                                    }
                                };
                            }
                        })
                    console.log(user.uid)

                    let doc;
                    if (doc_id)
                        doc = await getDocumentContent(doc_id, user.uid);

                    let quiz = (await createQuiz(content || doc.content, Math.abs(questions))).quiz;

                    res = {
                        success: true,
                        quiz: (questions === 1) ? quiz[0] : quiz
                    }
                } catch (err) {
                    if (err) {
                        res = {
                            success: false,
                            error: err.message
                        }
                        status = err.status || 500;
                    }
                }
            } else {
                res = {
                    success: false,
                    error: (!token) ? "Unauthorized" : "Bad Request"
                }
                status = (!token) ? 401 : 400;
            }

            return {
                body: JSON.stringify(res),
                status,
                headers: {
                    'Content-Type': 'application/json'
                }
            };
        }
    }
});