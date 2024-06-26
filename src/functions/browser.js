const {
    app
} = require('@azure/functions');
const puppeteer = require('puppeteer');
const {
    NodeHtmlMarkdown
} = require('node-html-markdown');
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


async function cleanup(md) {
    try {
        const modelName = "gpt-4-32k"

        const prompt = `
            You are an intelligent markdown parser. 
            When given the markdown representation of a website, you can intelligently identify the irrelevant parts of the page like headers, footers, navlinks, etc and filter them out to return the main content as a markdown file. 
            Make the content look neat and presentable.
            The main idea is to provide a clutter free representation of a website for educational purposes.
            Return a rich markdown file as the output.
        `

        /* let aiResponse = await model.call(prompt);
        return aiResponse.trim().replace(/\`{3}/gi, "") */

        let aiResponse = await model.chat.completions.create({
            messages: [
                {
                    "role": "system",
                    "content": prompt
                },
                {
                    "role": "user",
                    "content": md
                }
            ],
            model: modelName,
            temperature: 0.7
        })

        return aiResponse.choices[0].message.content;
    } catch (err) {
        if (err) {
            console.error(err);
            return null;
        }
    }
}

async function getPageContent(url) {
    try {
        const browser = await puppeteer.launch({
            executablePath: "chrome-linux/chrome",
            args: ['--no-sandbox'],
            headless: "new"
        })
        const page = await browser.newPage();
        await page.goto(url, {
            waitUntil: "networkidle0"
        });
        const content = await page.evaluate(() => document.body.innerHTML);
        //  console.log(content);
        await browser.close();
        return content;
    } catch (err) {
        if (err) {
            console.error(err);
            return null
        }
    }
}

app.http('browser', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);

        let status = 200,
            res;
        let token = request.headers.get("authorization");
        if (token) {
            token = token.split(" ")[1].trim();
            try {
                let user = await admin.auth().verifyIdToken(token)
                    .catch(err => {
                        if (err) {
                            status = 403;
                            res = {
                                success: false,
                                error: "Forbidden"
                            };

                            return {
                                body: JSON.stringify(res),
                                status,
                                headers: {
                                    'Content-Type': 'application/json'
                                }
                            };
                        }
                    });

                if (!user) {
                    status = 403;
                    res = {
                        success: false,
                        error: "Forbidden"
                    };

                    return {
                        body: JSON.stringify(res),
                        status,
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    };
                }

                const url = request.query.get('url') || null;
                const aiEnhanced = request.query.get('aiEnhanced') == "true";
                let msg;
                if (url) {
                    const content = await getPageContent(url);
                    const md = NodeHtmlMarkdown.translate(content);
                    (aiEnhanced) ? msg = await cleanup(md) : msg = md;
                    res = {
                        success: true,
                        content: msg
                    };
                    status = 200;
                } else {
                    res = {
                        success: false,
                        error: "Bad Request"
                    };
                    status = 400;
                }

            } catch (err) {
                if (err) {
                    res = {
                        success: false,
                        error: err.message
                    };
                    status = 500;
                }
            }
        } else {
            res = {
                success: false,
                error: (!token) ? "Unauthorized" : "Bad Request"
            };
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