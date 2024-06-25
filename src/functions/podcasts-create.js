const {
    app
} = require('@azure/functions');
const {
    MongoClient
} = require('mongodb');
const crypto = require("node:crypto")

const {
    redis
} = require("./cache")

require('dotenv').config({
    path: ".env"
});

const admin = require('firebase-admin');
var serviceAccount = require("../../project-x-92081-6c41507a6aa7.json");

async function savePodcast(podcast) {
    const client = new MongoClient(process.env.MONGO_CONNECTION_URL);
    const namespace = process.env.MONGO_NAMESPACE;
    const [dbName, ] = namespace.split(".");
    await client.connect();
    console.log("Connected successfully to Cosmos DB");
    const db = client.db(dbName);
    const collection = db.collection("podcasts");
    const session = client.startSession();

    try {
        session.startTransaction()
        podcast.id = crypto.randomBytes(4).toString("hex");

        await collection.insertOne(podcast, {
            session
        })

        await session.commitTransaction();
    } catch (err) {
        console.error(err.message)
        await session.abortTransaction();
        throw err;
    } finally {
        await session.endSession();
        await client.close();
    }
}

app.http('podcasts-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: "podcasts/create",
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);
        let status = 200,
            res;
        let token = request.headers.get("X-Auth-Token");
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
                console.log(user.uid);

                let data = await request.json();
                console.log(data)
                let interactive = new Boolean(data.hasOwnProperty("ph") || request.query.get("interactive") == "true")
                console.log("Interactive: " + interactive)
                const userRecord = await admin.auth().getUser(user.uid);
                data.user = {
                    name: userRecord.displayName,
                    phone: data.ph,
                    uid: user.uid
                }

                let podcast = await fetch(`${process.env.PODCASTS_BACKEND_URL}/podcasts/generate`, {
                    method: "POST",
                    headers: {
                        'Content-Type': "application/json"
                    },
                    body: JSON.stringify({
                        topic: data.topic,
                        characters: data.characters,
                        user: data.user
                    })
                }).then(res => res.json())

                if (podcast.error)
                    throw new Error(podcast.error)

                podcast.author = user.uid;
                podcast.created = Date.now();

                if (interactive) {
                    podcast.history = [];
                    podcast.user = data.user;
                    await redis.json.set(`podcast:user:${data.ph}`, "$", podcast, {
                        EX: 3600
                    })

                    await fetch(`${process.env.PODCASTS_BACKEND_URL}/twilio/call`, {
                        method: "POST",
                        headers: {
                            'Content-Type': "application/json"
                        },
                        body: JSON.stringify({
                            "ph": data.ph
                        })
                    }).then(res => res.json())
                } else {
                    await savePodcast(podcast);
                }

                res = {
                    success: true
                };
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