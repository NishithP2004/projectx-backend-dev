const {
    app
} = require('@azure/functions');

require('dotenv').config({
    path: ".env"
});
const {
    MongoClient
} = require('mongodb');
const admin = require('firebase-admin');

async function deletePodcast(podcast_id, user) {
    const client = new MongoClient(process.env.MONGO_CONNECTION_URL);
    const namespace = process.env.MONGO_NAMESPACE;
    const [dbName, ] = namespace.split(".");
    await client.connect();
    console.log("Connected successfully to Cosmos DB");
    const db = client.db(dbName);
    const podcastCollection = db.collection("podcasts");
    const session = client.startSession();
    try {
        session.startTransaction();

        await podcastCollection.findOneAndDelete({
            author: user,
            id: podcast_id
        }, {
            session
        }).then(res => console.log);

        // Committing the Transaction
        await session.commitTransaction();
        console.log("Transaction committed successfully");
    } catch (err) {
        if (err) {
            console.error("Error during transaction:", err);
            await session.abortTransaction();
        }

        return false;
    } finally {
        await session.endSession();
        client.close();
    }
    return true;
}

app.http('podcasts-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: "podcasts/{id}",
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);

        let status = 200,
            res;
        let token = request.headers.get("Authorization");
        const podcast_id = request.params.id;

        if (token && podcast_id) {
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

                res = {
                    success: await deletePodcast(podcast_id, user.uid)
                };
            } catch (err) {
                if (err) {
                    res = {
                        success: false,
                        error: err.message
                    };
                    status = err.status || 500;
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