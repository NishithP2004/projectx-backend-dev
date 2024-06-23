const {
    app
} = require('@azure/functions');
const {
    AzureKeyCredential,
    DocumentAnalysisClient
} = require("@azure/ai-form-recognizer");
const {
    BlobServiceClient
} = require("@azure/storage-blob");
const {
    RecursiveCharacterTextSplitter
} = require('langchain/text_splitter')
const {
    MongoDBAtlasVectorSearch
} = require('langchain/vectorstores/mongodb_atlas')
const {
    MongoClient
} = require('mongodb');
const {
    Document
} = require('langchain/document');
const {
    loadSummarizationChain
} = require("langchain/chains")
require('dotenv').config({
    path: ".env"
})

// -- Models -- 
const {
    AzureOpenAIEmbeddings,
    AzureChatOpenAI
} = require("@langchain/openai");

const embeddings = new AzureOpenAIEmbeddings({
    azureOpenAIApiKey: process.env.AZURE_OPENAI_STUDIO_API_KEY,
    azureOpenAIApiVersion: process.env.AZURE_OPENAI_STUDIO_API_VERSION,
    azureOpenAIApiEmbeddingsDeploymentName: "text-embedding-ada-002",
    endpoint: process.env.AZURE_OPENAI_STUDIO_API_ENDPOINT,
    model: "text-embedding-ada-002",
    azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_STUDIO_API_INSTANCE_NAME
})

/* const model = new AzureChatOpenAI({
    apiKey: process.env.AZURE_OPENAI_STUDIO_API_KEY,
    azureOpenAIApiKey: process.env.AZURE_OPENAI_STUDIO_API_KEY,
    azureOpenAIApiVersion: process.env.AZURE_OPENAI_STUDIO_API_VERSION,
    endpoint: process.env.AZURE_OPENAI_STUDIO_API_ENDPOINT,
    azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_STUDIO_API_INSTANCE_NAME,
    azureOpenAIApiDeploymentName: "gpt-4",
}) */

// Temporary fix for Rate Limit Issue with Azure Open AI
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai")

const model = new ChatGoogleGenerativeAI({
    modelName: "gemini-pro",
    apiKey: process.env.GEMINI_API_KEY,
    temperature: 0.7
});

// -- Models --

async function analyzeDocument(docUrl) {
    try {
        console.log(docUrl)
        const client = new DocumentAnalysisClient(process.env.AZURE_FR_ENDPOINT, new AzureKeyCredential(process.env.AZURE_FR_KEY));
        const poller = await client.beginAnalyzeDocument("prebuilt-read", docUrl);

        const {
            content,
            pages,
            languages,
            styles
        } = await poller.pollUntilDone();

        if (pages.length < 0) {
            console.log("No pages were extracted from the document.");
            return null;
        } else {
            console.log(content)
            return content
        }
    } catch (err) {
        if (err) {
            console.error(err);
            throw err;
        }
    }
}

async function saveDocumentContent(content, metadata) {
    const client = new MongoClient(process.env.MONGO_CONNECTION_URL)
    const namespace = process.env.MONGO_NAMESPACE;
    const [dbName, collectionName] = namespace.split(".");
    await client.connect();
    console.log("Connected successfully to Cosmos DB")
    const db = client.db(dbName)
    const collection = db.collection(collectionName);
    const session = client.startSession();
    try {
        session.startTransaction()
        const doc = {
            content,
            ...metadata
        }

        await collection.insertOne(doc, {
                session
            })
            .then(async (res) => {
                const coursesCollection = db.collection("courses")
                await coursesCollection.updateOne({
                    "course.id": metadata.course.id,
                    "course.name": metadata.course.name,
                    author: metadata.user
                }, {
                    $push: {
                        docs: res.insertedId
                    }
                }, {
                    upsert: true,
                    session
                })

                const splitter = new RecursiveCharacterTextSplitter();
                const documents = await splitter.splitDocuments([
                    new Document({
                        pageContent: content,
                        metadata: {
                            doc_id: res.insertedId,
                            user: metadata.user,
                            course: metadata.course.id
                        }
                    })
                ])
                let docCollection = db.collection('documents')

                console.log(`Checking if vector index exists in the documents collection`)
                const vectorIndexExists = await docCollection.indexExists('vectorSearchIndex');
                if (!vectorIndexExists) {
                    await db.command({
                        "createIndexes": "documents",
                        "indexes": [{
                            "name": "vectorSearchIndex",
                            "key": {
                                "embedding": "cosmosSearch"
                            },
                            "cosmosSearchOptions": {
                                "kind": "vector-ivf",
                                "numLists": 1,
                                "similarity": "COS",
                                "dimensions": 1536
                            }
                        }]
                    });
                    console.log(`Created vector index on embedding field on documents collection`);
                } else {
                    console.log(`Vector index already exists on embedding field in the documents collection`);
                }

                const vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
                    collection: docCollection,
                    indexName: "vectorSearchIndex",
                    embeddingKey: "embedding",
                    textKey: "text"
                })

                // Generating a summary
                const chain = loadSummarizationChain(model, {
                    type: "stuff"
                })

                const summary = (await chain.call({
                    input_documents: documents
                })).text

                await collection.updateOne({
                    _id: res.insertedId
                }, {
                    $set: {
                        summary
                    }
                }, {
                    upsert: false,
                    session
                })

                await vectorStore.addDocuments(documents)
                await session.commitTransaction();
            })
            .catch(async (err) => {
                throw err;
            })
    } catch (err) {
        if (err) {
            console.error(err);
            await session.abortTransaction();
            throw err;
        }
    } finally {
        await session.endSession()
        client.close()
    }

}

async function deleteBlobIfItExists(blobName) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING)
    const container = process.env.AZURE_STORAGE_CONTAINER_NAME;
    const containerClient = blobServiceClient.getContainerClient(container);

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.deleteIfExists({
        deleteSnapshots: "include"
    });
    console.log(`deleted blob ${blobName}`);
}

app.storageBlob('storageBlobTrigger1', {
    path: 'documents/{name}',
    connection: 'AzureWebJobsStorage',
    handler: async (blob, context) => {
        let triggerMetadata = context.triggerMetadata;
        const docUrl = context.triggerMetadata.uri;

        try {
            const metadata = {
                user: triggerMetadata.metadata.user_uid,
                course: {
                    name: triggerMetadata.metadata.course_name,
                    id: triggerMetadata.metadata.course_id
                },
                blob: {
                    name: triggerMetadata.name,
                    uri: triggerMetadata.uri
                }
            }
            let content = await analyzeDocument(docUrl)
            if (content)
                await saveDocumentContent(content, metadata)
            else {
                console.log("No Content");
                await deleteBlobIfItExists(triggerMetadata.name)
            }
        } catch (err) {
            if(err) {
                console.error(err);
                await deleteBlobIfItExists(triggerMetadata.name)
            }
        }

        context.log(`Storage blob function processed blob "${context.triggerMetadata.name}" with size ${blob.length} bytes`);
    }
}); 