const {
    app
} = require('@azure/functions');
require('dotenv').config({
    path: ".env"
});
const admin = require('firebase-admin');

async function search(query = "AI", type = "google") {
    try {
        let url, result = [];
        if (type.toLowerCase() == "google") {
            url = `https://www.googleapis.com/customsearch/v1/?cx=${process.env.G_CX}&key=${process.env.G_SEARCH_KEY}&q=${query}`
            let res = await fetch(url)
                .then(r => r.json())
                .catch(err => {
                    if (err) console.log(err);
                })
            result = res.items.map(item => {
                return {
                    title: item.title,
                    link: item.link,
                    displayLink: item.displayLink,
                    snippet: item.snippet,
                    thumbnail: (item.pagemap ?.cse_thumbnail) ? item.pagemap?.cse_thumbnail[0]?.src : undefined,
                    image: (item.pagemap.cse_image) ? item.pagemap.cse_image[0]?.src : undefined,
                    favicon: `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${item.link}&size=64`
                }
            })
        } else if (type.toLowerCase() == "bing") {
            url = `https://api.bing.microsoft.com/v7.0/custom/search?q=${query}&customconfig=${process.env.BING_CONFIG_ID}&mkt=en-US`
            let res = await fetch(url, {
                    headers: {
                        "Ocp-Apim-Subscription-Key": process.env.BING_API_KEY
                    }
                })
                .then(r => r.json())
                .catch(err => {
                    if (err) console.log(err);
                })
            result = res.webPages.value.map(item => {
                return {
                    title: item.name,
                    link: item.url,
                    displayLink: item.displayUrl,
                    snippet: item.snippet,
                    image: (item.openGraphImage ?.contentUrl) ? item.openGraphImage.contentUrl : undefined,
                    favicon: `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${item.url}&size=64`
                }
            })
        }
        return result;
    } catch (err) {
        if (err) {
            console.error(err);
            return null;
        }
    }
}

app.http('search', {
    methods: ["GET"],
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
                const type = request.query.get('type') || "bing";

                if (query) {
                    res = {
                        success: true,
                        result: await search(query, type)
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