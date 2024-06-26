const { app } = require('@azure/functions');
const {
    MongoClient,
    ObjectId
} = require('mongodb');
// const tokenizer = require('gpt-tokenizer')

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

async function formatDocument(document) {
    try {
        const modelName = "gpt-4-32k"

        const prompt = `
                You are an intelligent text formatter.
                Given an unstructured text without any line breaks or new lines, 
                you can intelligently format it and return the output text with the necessary indentation added.
                Format the input as a document.
                IMPORTANT: If the input contains unsafe html like script tags which can cause XSS related attacks, escape them / include them in a code block to avoid execution.
                Heading levels begin from the second level (h2).
                Return the result as a rich markdown file with the headings formatted, enabling the result to be directly rendered by a markdown parser.
        `
        /* let res = await model.invoke(prompt);
        console.log(res.content)
        
        return res.content; */
        let res = await model.chat.completions.create({
            messages: [
                {
                    "role": "system",
                    "content": prompt
                },
                {
                    "role": "user",
                    "content": document
                }
            ],
            model: modelName,
            temperature: 0.7
        })

        return res.choices[0].message.content;
    } catch(err) {
        if(err) {
            console.error(err);
            return document;
        }
    }
}

async function getDocumentContent(doc_id, user) {
    try {
        const client = new MongoClient(process.env.MONGO_CONNECTION_URL)
        const namespace = process.env.MONGO_NAMESPACE;
        const [dbName, ] = namespace.split(".");
        await client.connect();
        console.log("Connected successfully to Cosmos DB")
        const db = client.db(dbName)
        const collection = db.collection("documents-ocr");

        let doc = await collection.findOne({
            _id: new ObjectId(doc_id),
            user
        });
        
        console.log(doc)
        if(!doc.content) throw { message: "Requested document Not Found", status: 404 }

        return {
            content: doc.content,
            summary: doc.summary
        };

    } catch (err) {
        if (err) {
            console.error(err)
            throw err
        }
    }
}

app.http('courses-doc-content', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: "courses/documents/{id}",
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);
        // const MAX_TOKENS = parseInt(process.env.MAX_TOKENS) || 2048;

        let status = 200,
            res;
        let token = request.headers.get("authorization");
        const doc_id = request.params.id || null;

        if (token && doc_id) {
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

                let doc = await getDocumentContent(doc_id, user.uid);

                res = {
                    success: true,
                    content: await formatDocument(doc.content),
                    summary: doc.summary
                }
            } catch (err) {
                if (err) {
                    res = {
                        success: false,
                        error: err.message,
                        content: doc.content,
                        summary: doc.summary
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
});

module.exports = getDocumentContent