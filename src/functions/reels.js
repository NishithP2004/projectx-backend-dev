const {
    app
} = require('@azure/functions');
const {
    YoutubeTranscript
} = require("youtube-transcript");
require('dotenv').config({
    path: ".env"
});
const admin = require('firebase-admin');

async function searchVideos(query) {
    try {
        let result = [];
        const url = `https://youtube.googleapis.com/youtube/v3/search?q=${query}&key=${process.env.YT_API_KEY}&&maxResults=10&type=video&videoEmbeddable=true&videoDuration=short&videoCaption=closedCaption`;
        let res = await fetch(url)
            .then(r => r.json())
            .catch(err => {
                if (err)
                    console.error(err)
            })

        result = res.items.map(async item => {
            return {
                id: item.id.videoId,
                url: `https://youtube.com/watch?v=${item.id.videoId}`,
                transcript: (await getTranscript(item.id.videoId))
            }
        })
        console.log(result)

        return (await Promise.all(result))
    } catch (err) {
        if (err) {
            console.error(err);
            return null;
        }
    }
}

async function getTranscript(videoId) {
    let r = await YoutubeTranscript.fetchTranscript(videoId);
    return r.map(e => e.text).join(" ");
}

app.http('reels', {
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

                const query = request.query.get('q');

                if (query) {
                    res = {
                        success: true,
                        result: await searchVideos(query)
                    };
                    status = 200;
                } else {
                    res = {
                        error: "Bad Request",
                        success: false
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