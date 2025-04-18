Text generation

The Gemini API can generate text output in response to various inputs, including text, images, video, and audio. This guide shows you how to generate text using text and image inputs. It also covers streaming, chat, and system instructions.

Before you begin

Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Text input

The simplest way to generate text using the Gemini API is to provide the model with a single text-only input, as shown in this example:

Python

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content( model="gemini-2.0-flash", contents=["How does AI work?"] ) print(response.text)

JavaScript

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: "How does AI work?", }); console.log(response.text); }

await main();

Go

// import packages here

func main() { ctx := context.Background() client, err := genai.NewClient(ctx, option.WithAPIKey(os.Getenv("GEMINI_API_KEY"))) if err != nil { log.Fatal(err) } defer client.Close()

model := client.GenerativeModel("gemini-2.0-flash") resp, err := model.GenerateContent(ctx, genai.Text("How does AI work?")) if err != nil { log.Fatal(err) } printResponse(resp) // helper function for printing content parts }

REST

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY" \ -H 'Content-Type: application/json' \ -X POST \ -d '{ "contents": [ { "parts": [ { "text": "How does AI work?" } ] } ] }'

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const payload = { contents: [ { parts: [ { text: 'How AI does work?' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

Image input

The Gemini API supports multimodal inputs that combine text and media files. The following example shows how to generate text from text and image input:

Python

from PIL import Image from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

image = Image.open("/path/to/organ.png") response = client.models.generate_content( model="gemini-2.0-flash", contents=[image, "Tell me about this instrument"] ) print(response.text)

JavaScript

import { GoogleGenAI, createUserContent, createPartFromUri, } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const image = await ai.files.upload({ file: "/path/to/organ.png", }); const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: [ createUserContent([ "Tell me about this instrument", createPartFromUri(image.uri, image.mimeType), ]), ], }); console.log(response.text); }

await main();

Go

model := client.GenerativeModel("gemini-2.0-flash")

imgData, err := os.ReadFile(filepath.Join(testDataDir, "organ.jpg")) if err != nil { log.Fatal(err) }

resp, err := model.GenerateContent(ctx, genai.Text("Tell me about this instrument"), genai.ImageData("jpeg", imgData)) if err != nil { log.Fatal(err) }

printResponse(resp)

REST

# Use a temporary file to hold the base64 encoded image data TEMP_B64=$(mktemp) trap 'rm -f "$TEMP_B64"' EXIT base64 $B64FLAGS $IMG_PATH > "$TEMP_B64"

# Use a temporary file to hold the JSON payload TEMP_JSON=$(mktemp) trap 'rm -f "$TEMP_JSON"' EXIT

cat > "$TEMP_JSON" << EOF { "contents": [ { "parts": [ { "text": "Tell me about this instrument" }, { "inline_data": { "mime_type": "image/jpeg", "data": "$(cat "$TEMP_B64")" } } ] } ] } EOF

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY" \ -H 'Content-Type: application/json' \ -X POST \ -d "@$TEMP_JSON"

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const imageUrl = 'http://image/url'; const image = getImageData(imageUrl); const payload = { contents: [ { parts: [ { image }, { text: 'Tell me about this instrument' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

function getImageData(url) { const blob = UrlFetchApp.fetch(url).getBlob();

return { mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) }; }

Streaming output

By default, the model returns a response after completing the entire text generation process. You can achieve faster interactions by using streaming to return instances of GenerateContentResponse as they're generated.

Python

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content_stream( model="gemini-2.0-flash", contents=["Explain how AI works"] ) for chunk in response: print(chunk.text, end="")

JavaScript

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const response = await ai.models.generateContentStream({ model: "gemini-2.0-flash", contents: "Explain how AI works", });

for await (const chunk of response) { console.log(chunk.text); } }

await main();

Go

model := client.GenerativeModel("gemini-1.5-flash") iter := model.GenerateContentStream(ctx, genai.Text("Write a story about a magic backpack.")) for { resp, err := iter.Next() if err == iterator.Done { break } if err != nil { log.Fatal(err) } printResponse(resp) }

REST

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}" \ -H 'Content-Type: application/json' \ --no-buffer \ -d '{ "contents": [ { "parts": [ { "text": "Explain how AI works" } ] } ] }'

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const payload = { contents: [ { parts: [ { text: 'Explain how AI works' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

Multi-turn conversations

The Gemini SDK lets you collect multiple rounds of questions and responses into a chat. The chat format enables users to step incrementally toward answers and to get help with multipart problems. This SDK implementation of chat provides an interface to keep track of conversation history, but behind the scenes it uses the same generateContent method to create the response.

The following code example shows a basic chat implementation:

Python

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY") chat = client.chats.create(model="gemini-2.0-flash")

response = chat.send_message("I have 2 dogs in my house.") print(response.text)

response = chat.send_message("How many paws are in my house?") print(response.text)

for message in chat.get_history(): print(f'role - {message.role}',end=": ") print(message.parts[0].text)

JavaScript

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const chat = ai.chats.create({ model: "gemini-2.0-flash", history: [ { role: "user", parts: [{ text: "Hello" }], }, { role: "model", parts: [{ text: "Great to meet you. What would you like to know?" }], }, ], });

const response1 = await chat.sendMessage({ message: "I have 2 dogs in my house.", }); console.log("Chat response 1:", response1.text);

const response2 = await chat.sendMessage({ message: "How many paws are in my house?", }); console.log("Chat response 2:", response2.text); }

await main();

Go

model := client.GenerativeModel("gemini-1.5-flash") cs := model.StartChat()

cs.History = []*genai.Content{ { Parts: []genai.Part{ genai.Text("Hello, I have 2 dogs in my house."), }, Role: "user", }, { Parts: []genai.Part{ genai.Text("Great to meet you. What would you like to know?"), }, Role: "model", }, }

res, err := cs.SendMessage(ctx, genai.Text("How many paws are in my house?")) if err != nil { log.Fatal(err) } printResponse(res)

REST

curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY \ -H 'Content-Type: application/json' \ -X POST \ -d '{ "contents": [ { "role": "user", "parts": [ { "text": "Hello" } ] }, { "role": "model", "parts": [ { "text": "Great to meet you. What would you like to know?" } ] }, { "role": "user", "parts": [ { "text": "I have two dogs in my house. How many paws are in my house?" } ] } ] }'

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const payload = { contents: [ { role: 'user', parts: [ { text: 'Hello' }, ], }, { role: 'model', parts: [ { text: 'Great to meet you. What would you like to know?' }, ], }, { role: 'user', parts: [ { text: 'I have two dogs in my house. How many paws are in my house?' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

You can also use streaming with chat, as shown in the following example:

Python

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY") chat = client.chats.create(model="gemini-2.0-flash")

response = chat.send_message_stream("I have 2 dogs in my house.") for chunk in response: print(chunk.text, end="")

response = chat.send_message_stream("How many paws are in my house?") for chunk in response: print(chunk.text, end="")

for message in chat.get_history(): print(f'role - {message.role}', end=": ") print(message.parts[0].text)

JavaScript

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const chat = ai.chats.create({ model: "gemini-2.0-flash", history: [ { role: "user", parts: [{ text: "Hello" }], }, { role: "model", parts: [{ text: "Great to meet you. What would you like to know?" }], }, ], });

const stream1 = await chat.sendMessageStream({ message: "I have 2 dogs in my house.", }); for await (const chunk of stream1) { console.log(chunk.text); console.log("_".repeat(80)); }

const stream2 = await chat.sendMessageStream({ message: "How many paws are in my house?", }); for await (const chunk of stream2) { console.log(chunk.text); console.log("_".repeat(80)); } }

await main();

Go

model := client.GenerativeModel("gemini-1.5-flash") cs := model.StartChat()

cs.History = []*genai.Content{ { Parts: []genai.Part{ genai.Text("Hello, I have 2 dogs in my house."), }, Role: "user", }, { Parts: []genai.Part{ genai.Text("Great to meet you. What would you like to know?"), }, Role: "model", }, }

iter := cs.SendMessageStream(ctx, genai.Text("How many paws are in my house?")) for { resp, err := iter.Next() if err == iterator.Done { break } if err != nil { log.Fatal(err) } printResponse(resp) }

REST

curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=$GEMINI_API_KEY \ -H 'Content-Type: application/json' \ -X POST \ -d '{ "contents": [ { "role": "user", "parts": [ { "text": "Hello" } ] }, { "role": "model", "parts": [ { "text": "Great to meet you. What would you like to know?" } ] }, { "role": "user", "parts": [ { "text": "I have two dogs in my house. How many paws are in my house?" } ] } ] }'

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const payload = { contents: [ { role: 'user', parts: [ { text: 'Hello' }, ], }, { role: 'model', parts: [ { text: 'Great to meet you. What would you like to know?' }, ], }, { role: 'user', parts: [ { text: 'I have two dogs in my house. How many paws are in my house?' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

Configuration parameters

Every prompt you send to the model includes parameters that control how the model generates responses. You can configure these parameters, or let the model use the default options.

The following example shows how to configure model parameters:

Python

from google import genai from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content( model="gemini-2.0-flash", contents=["Explain how AI works"], config=types.GenerateContentConfig( max_output_tokens=500, temperature=0.1 ) ) print(response.text)

JavaScript

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: "Explain how AI works", config: { maxOutputTokens: 500, temperature: 0.1, }, }); console.log(response.text); }

await main();

Go

model := client.GenerativeModel("gemini-1.5-pro-latest") model.SetTemperature(0.9) model.SetTopP(0.5) model.SetTopK(20) model.SetMaxOutputTokens(100) model.SystemInstruction = genai.NewUserContent(genai.Text("You are Yoda from Star Wars.")) model.ResponseMIMEType = "application/json" resp, err := model.GenerateContent(ctx, genai.Text("What is the average size of a swallow?")) if err != nil { log.Fatal(err) } printResponse(resp)

REST

curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY \ -H 'Content-Type: application/json' \ -X POST \ -d '{ "contents": [ { "parts": [ { "text": "Explain how AI works" } ] } ], "generationConfig": { "stopSequences": [ "Title" ], "temperature": 1.0, "maxOutputTokens": 800, "topP": 0.8, "topK": 10 } }'

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const generationConfig = { temperature: 1, topP: 0.95, topK: 40, maxOutputTokens: 8192, responseMimeType: 'text/plain', };

const payload = { generationConfig, contents: [ { parts: [ { text: 'Explain how AI works in a few words' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

Here are some of the model parameters you can configure. (Naming conventions vary by programming language.)

stopSequences: Specifies the set of character sequences (up to 5) that will stop output generation. If specified, the API will stop at the first appearance of a stop_sequence. The stop sequence won't be included as part of the response.

temperature: Controls the randomness of the output. Use higher values for more creative responses, and lower values for more deterministic responses. Values can range from [0.0, 2.0].

maxOutputTokens: Sets the maximum number of tokens to include in a candidate.

topP: Changes how the model selects tokens for output. Tokens are selected from the most to least probable until the sum of their probabilities equals the topP value. The default topP value is 0.95.

topK: Changes how the model selects tokens for output. A topK of 1 means the selected token is the most probable among all the tokens in the model's vocabulary, while a topK of 3 means that the next token is selected from among the 3 most probable using the temperature. Tokens are further filtered based on topP with the final token selected using temperature sampling.

System instructions

System instructions let you steer the behavior of a model based on your specific use case. When you provide system instructions, you give the model additional context to help it understand the task and generate more customized responses. The model should adhere to the system instructions over the full interaction with the user, enabling you to specify product-level behavior separate from the prompts provided by end users.

You can set system instructions when you initialize your model:

Python

from google import genai from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content( model="gemini-2.0-flash", config=types.GenerateContentConfig( system_instruction="You are a cat. Your name is Neko."), contents="Hello there" )

print(response.text)

JavaScript

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "GEMINI_API_KEY" });

async function main() { const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: "Hello there", config: { systemInstruction: "You are a cat. Your name is Neko.", }, }); console.log(response.text); }

await main();

Go

// import packages here

func main() { ctx := context.Background() client, err := genai.NewClient(ctx, option.WithAPIKey(os.Getenv("GEMINI_API_KEY"))) if err != nil { log.Fatal(err) } defer client.Close()

model := client.GenerativeModel("gemini-2.0-flash") model.SystemInstruction = &genai.Content{ Parts: []genai.Part{genai.Text(` You are a cat. Your name is Neko. `)}, } resp, err := model.GenerateContent(ctx, genai.Text("Hello there")) if err != nil { log.Fatal(err) } printResponse(resp) // helper function for printing content parts }

REST

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY" \ -H 'Content-Type: application/json' \ -d '{ "system_instruction": { "parts": [ { "text": "You are a cat. Your name is Neko." } ] }, "contents": [ { "parts": [ { "text": "Hello there" } ] } ] }'

Apps Script

// See https://developers.google.com/apps-script/guides/properties // for instructions on how to set the API key. const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

function main() { const systemInstruction = { parts: [{ text: 'You are a cat. Your name is Neko.' }] };

const payload = { systemInstruction, contents: [ { parts: [ { text: 'Hello there' }, ], }, ], };

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`; const options = { method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload) };

const response = UrlFetchApp.fetch(url, options); const data = JSON.parse(response); const content = data['candidates'][0]['content']['parts'][0]['text']; console.log(content); }

Then, you can send requests to the model as usual.

Supported models

The entire Gemini family of models supports text generation. To learn more about the models and their capabilities, see Models.

Prompting tips

For basic text generation use cases, your prompt might not need to include any output examples, system instructions, or formatting information. This is a zero-shot approach. For some use cases, a one-shot or few-shot prompt might produce output that's more aligned with user expectations. In some cases, you might also want to provide system instructions to help the model understand the task or follow specific guidelines.


Gemini models are able to process images and videos, enabling many frontier developer use cases that would have historically required domain specific models. Some of Gemini's vision capabilities include the ability to:

Caption and answer questions about images Transcribe and reason over PDFs, including up to 2 million tokens Describe, segment, and extract information from videos up to 90 minutes long Detect objects in an image and return bounding box coordinates for them

Gemini was built to be multimodal from the ground up and we continue to push the frontier of what is possible.

Before you begin

Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Image input

For total image payload size less than 20MB, we recommend either uploading base64 encoded images or directly uploading locally stored image files.

Working with local images

If you are using the Python imaging library (Pillow), you can use PIL image objects too.

from google import genai from google.genai import types

import PIL.Image

image = PIL.Image.open('/path/to/image.png')

client = genai.Client(api_key="GEMINI_API_KEY") response = client.models.generate_content( model="gemini-2.0-flash", contents=["What is this image?", image])

print(response.text)

Base64 encoded images

You can upload public image URLs by encoding them as Base64 payloads. The following code example shows how to do this using only standard library tools:

from google import genai from google.genai import types

import requests

image_path = "https://goo.gle/instrument-img" image = requests.get(image_path)

client = genai.Client(api_key="GEMINI_API_KEY") response = client.models.generate_content( model="gemini-2.0-flash-exp", contents=["What is this image?", types.Part.from_bytes(data=image.content, mime_type="image/jpeg")])

print(response.text)

Multiple images

To prompt with multiple images, you can provide multiple images in the call to generate_content. These can be in any supported format, including base64 or PIL.

from google import genai from google.genai import types

import pathlib import PIL.Image

image_path_1 = "path/to/your/image1.jpeg" # Replace with the actual path to your first image image_path_2 = "path/to/your/image2.jpeg" # Replace with the actual path to your second image

image_url_1 = "https://goo.gle/instrument-img" # Replace with the actual URL to your third image

pil_image = PIL.Image.open(image_path_1)

b64_image = types.Part.from_bytes( data=pathlib.Path(image_path_2).read_bytes(), mime_type="image/jpeg" )

downloaded_image = requests.get(image_url_1)

client = genai.Client(api_key="GEMINI_API_KEY") response = client.models.generate_content( model="gemini-2.0-flash-exp", contents=["What do these images have in common?", pil_image, b64_image, downloaded_image])

print(response.text)

Note that these inline data calls don't include many of the features available through the File API, such as getting file metadata, listing, or deleting files.

Large image payloads

When the combination of files and system instructions that you intend to send is larger than 20 MB in size, use the File API to upload those files.

Use the media.upload method of the File API to upload an image of any size. Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but cannot be downloaded from the API. It is available at no cost in all regions where the Gemini API is available. After uploading the file, you can make GenerateContent requests that reference the File API URI. Select the generative model and provide it with a text prompt and the uploaded image.

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

img_path = "/path/to/Cajun_instruments.jpg" file_ref = client.files.upload(file=img_path) print(f'{file_ref=}')

client = genai.Client(api_key="GEMINI_API_KEY") response = client.models.generate_content( model="gemini-2.0-flash-exp", contents=["What can you tell me about these instruments?", file_ref])

print(response.text)

OpenAI Compatibility

You can access Gemini's image understanding capabilities using the OpenAI libraries. This lets you integrate Gemini into existing OpenAI workflows by updating three lines of code and using your Gemini API key. See the Image understanding example for code demonstrating how to send images encoded as Base64 payloads.

Prompting with images

In this tutorial, you will upload images using the File API or as inline data and generate content based on those images.

Technical details (images)

Gemini 2.0 Flash, 1.5 Pro, and 1.5 Flash support a maximum of 3,600 image files.

Images must be in one of the following image data MIME types:

PNG - image/png

JPEG - image/jpeg

WEBP - image/webp

HEIC - image/heic

HEIF - image/heif

Tokens

Here's how tokens are calculated for images:

Gemini 1.0 Pro Vision: Each image accounts for 258 tokens.

Gemini 1.5 Flash and Gemini 1.5 Pro: If both dimensions of an image are less than or equal to 384 pixels, then 258 tokens are used. If one dimension of an image is greater than 384 pixels, then the image is cropped into tiles. Each tile size defaults to the smallest dimension (width or height) divided by 1.5. If necessary, each tile is adjusted so that it's not smaller than 256 pixels and not greater than 768 pixels. Each tile is then resized to 768x768 and uses 258 tokens.

Gemini 2.0 Flash: Image inputs with both dimensions <=384 pixels are counted as 258 tokens. Images larger in one or both dimensions are cropped and scaled as needed into tiles of 768x768 pixels, each counted as 258 tokens.

For best results

Rotate images to the correct orientation before uploading. Avoid blurry images. If using a single image, place the text prompt after the image.

Capabilities

This section outlines specific vision capabilities of the Gemini model, including object detection and bounding box coordinates.

Get a bounding box for an object

Gemini models are trained to return bounding box coordinates as relative widths or heights in the range of [0, 1]. These values are then scaled by 1000 and converted to integers. Effectively, the coordinates represent the bounding box on a 1000x1000 pixel version of the image. Therefore, you'll need to convert these coordinates back to the dimensions of your original image to accurately map the bounding boxes.

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

prompt = ( "Return a bounding box for each of the objects in this image " "in [ymin, xmin, ymax, xmax] format.")

response = client.models.generate_content( model="gemini-1.5-pro", contents=[sample_file_1, prompt])

print(response.text)

You can use bounding boxes for object detection and localization within images and video. By accurately identifying and delineating objects with bounding boxes, you can unlock a wide range of applications and enhance the intelligence of your projects.

Key Benefits

Simple: Integrate object detection capabilities into your applications with ease, regardless of your computer vision expertise.

Customizable: Produce bounding boxes based on custom instructions (e.g. "I want to see bounding boxes of all the green objects in this image"), without having to train a custom model.

Technical Details

Input: Your prompt and associated images or video frames.

Output: Bounding boxes in the [y_min, x_min, y_max, x_max] format. The top left corner is the origin. The x and y axis go horizontally and vertically, respectively. Coordinate values are normalized to 0-1000 for every image.

Visualization: AI Studio users will see bounding boxes plotted within the UI.

For Python developers, try the 2D spatial understanding notebook or the experimental 3D pointing notebook.

Normalize coordinates

The model returns bounding box coordinates in the format [y_min, x_min, y_max, x_max]. To convert these normalized coordinates to the pixel coordinates of your original image, follow these steps:

Divide each output coordinate by 1000. Multiply the x-coordinates by the original image width. Multiply the y-coordinates by the original image height.

To explore more detailed examples of generating bounding box coordinates and visualizing them on images, we encourage you to review our Object Detection cookbook example.

Image segmentation

Starting with the 2.5 generation, Gemini models are trained to not only detect items but segment them and provide a mask of their contour.

The model predicts a JSON list, where each item represents a segmentation mask. Each item has a bounding box ("box_2d") in the format [y0, x0, y1, x1] with normalized coordinates between 0 and 1000, a label ("label") that identifies the object, and finally the segmentation mask inside the bounding box, as base64 encoded png that is a probability map with values between 0 and 255. The mask needs to be resized to match the bounding box dimensions, then binarized at your confidence threshold (127 for the midpoint).

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

prompt = """ Give the segmentation masks for the wooden and glass items. Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label". Use descriptive labels. """

response = client.models.generate_content( model="gemini-2.5-pro-exp-03-25", contents=[sample_file_1, prompt])

print(response.text)

Mask of the wooden and glass objects found on the picture

Check the segmentation example in the cookbook guide for a more detailed example.

Prompting with video

In this tutorial, you will upload a video using the File API and generate content based on those images.

Technical details (video)

Gemini 1.5 Pro and Flash support up to approximately an hour of video data.

Video must be in one of the following video format MIME types:

video/mp4 video/mpeg video/mov video/avi video/x-flv video/mpg video/webm video/wmv video/3gpp

The File API service extracts image frames from videos at 1 frame per second (FPS) and audio at 1Kbps, single channel, adding timestamps every second. These rates are subject to change in the future for improvements in inference. Note: The details of fast action sequences may be lost at the 1 FPS frame sampling rate. Consider slowing down high-speed clips for improved inference quality. Individual frames are 258 tokens, and audio is 32 tokens per second. With metadata, each second of video becomes ~300 tokens, which means a 1M context window can fit slightly less than an hour of video. As a result, Gemini Pro, which has a 2M context window, can handle a maximum video length of 2 hours, and Gemini Flash, which has a 1M context window, can handle a maximum video length of 1 hour.

To ask questions about time-stamped locations, use the format MM:SS, where the first two digits represent minutes and the last two digits represent seconds.

For best results:

Use one video per prompt. If using a single video, place the text prompt after the video.

Upload a video file using the File API Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but they cannot be downloaded using any API. It is available at no cost in all regions where the Gemini API is available. The File API accepts video file formats directly. This example uses the short NASA film "Jupiter's Great Red Spot Shrinks and Grows". Credit: Goddard Space Flight Center (GSFC)/David Ladd (2018).

"Jupiter's Great Red Spot Shrinks and Grows" is in the public domain and does not show identifiable people. (NASA image and media usage guidelines.)

Start by retrieving the short video:

wget https://storage.googleapis.com/generativeai-downloads/images/GreatRedSpot.mp4 Upload the video using the File API and print the URI.

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

print("Uploading file...") video_file = client.files.upload(file="GreatRedSpot.mp4") print(f"Completed upload: {video_file.uri}")

Verify file upload and check state

Verify the API has successfully received the files by calling the files.get method. Note: Video files have a State field in the File API. When a video is uploaded, it will be in the PROCESSING state until it is ready for inference. Only ACTIVE files can be used for model inference. import time

# Check whether the file is ready to be used. while video_file.state.name == "PROCESSING": print('.', end='') time.sleep(1) video_file = client.files.get(name=video_file.name)

if video_file.state.name == "FAILED": raise ValueError(video_file.state.name)

print('Done')

Prompt with a video and text

Once the uploaded video is in the ACTIVE state, you can make GenerateContent requests that specify the File API URI for that video. Select the generative model and provide it with the uploaded video and a text prompt.

from IPython.display import Markdown

# Pass the video file reference like any other media part. response = client.models.generate_content( model="gemini-1.5-pro", contents=[ video_file, "Summarize this video. Then create a quiz with answer key " "based on the information in the video."])

# Print the response, rendering any Markdown Markdown(response.text)

Upload a video inline

If your video is less than 20MB, you can include it inline with your request as a data Part.

Here's an example of uploading a video inline:

# Only for videos of size <20Mb video_file_name = "/path/to/your/video.mp4" video_bytes = open(video_file_name, 'rb').read()

response = client.models.generate_content( model='models/gemini-2.0-flash', contents=types.Content( parts=[ types.Part(text='Can you summarize this video?'), types.Part( inline_data=types.Blob(data=video_bytes, mime_type='video/mp4') ) ] ) )

Include a YouTube URL Preview: The YouTube URL feature is in preview and is currently free of charge. Pricing and rate limits are likely to change. The Gemini API and AI Studio support YouTube URLs as a file data Part. You can include a YouTube URL with a prompt asking the model to summarize, translate, or otherwise interact with the video content.

Limitations:

You can't upload more than 8 hours of YouTube video per day. You can upload only 1 video per request. You can only upload public videos (not private or unlisted videos).

Note: Gemini Pro, which has a 2M context window, can handle a maximum video length of 2 hours, and Gemini Flash, which has a 1M context window, can handle a maximum video length of 1 hour. The following example shows how to include a YouTube URL with a prompt:

response = client.models.generate_content( model='models/gemini-2.0-flash', contents=types.Content( parts=[ types.Part(text='Can you summarize this video?'), types.Part( file_data=types.FileData(file_uri='https://www.youtube.com/watch?v=9hE5-98ZeCg') ) ] ) )

Refer to timestamps in the content

You can use timestamps of the form MM:SS to refer to specific moments in the video.

prompt = "What are the examples given at 01:05 and 01:19 supposed to show us?"

response = client.models.generate_content( model="gemini-1.5-pro", contents=[video_file, prompt])

print(response.text)

Transcribe video and provide visual descriptions

The Gemini models can transcribe and provide visual descriptions of video content by processing both the audio track and visual frames. For visual descriptions, the model samples the video at a rate of 1 frame per second. This sampling rate may affect the level of detail in the descriptions, particularly for videos with rapidly changing visuals.

prompt = ( "Transcribe the audio from this video, giving timestamps for " "salient events in the video. Also provide visual descriptions.")

response = client.models.generate_content( model="gemini-1.5-pro", contents=[video_file, prompt])

print(response.text)

List files

You can list all files uploaded using the File API and their URIs using files.list.

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

print('My files:') for f in client.files.list(): print(" ", f'{f.name}: {f.uri}')

Delete files

Files uploaded using the File API are automatically deleted after 2 days. You can also manually delete them using files.delete.

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

# Upload a file poem_file = client.files.upload(file="poem.txt")

# Files will auto-delete after a period. print(poem_file.expiration_time)

# Or they can be deleted explicitly. dr = client.files.delete(name=poem_file.name)

try: client.models.generate_content( model="gemini-2.0-flash-exp", contents=['Finish this poem:', poem_file]) except genai.errors.ClientError as e: print(e.code) # 403 print(e.status) # PERMISSION_DENIED print(e.message) # You do not have permission to access the File .. or it may not exist.

What's next

This guide shows how to upload image and video files using the File API and then generate text outputs from image and video inputs. To learn more, see the following resources:

File prompting strategies: The Gemini API supports prompting with text, image, audio, and video data, also known as multimodal prompting.

System instructions: System instructions let you steer the behavior of the model based on your specific needs and use cases.

Safety guidance: Sometimes generative AI models produce unexpected outputs, such as outputs that are inaccurate, biased, or offensive. Post-processing and human evaluation are essential to limit the risk of harm from such outputs.


The Gemini API code execution feature enables the model to generate and run Python code and learn iteratively from the results until it arrives at a final output. You can use this code execution capability to build applications that benefit from code-based reasoning and that produce text output. For example, you could use code execution in an application that solves equations or processes text. Note: Gemini is only able to execute code in Python. You can still ask Gemini to generate code in another language, but the model can't use the code execution tool to run it. Code execution is available in both AI Studio and the Gemini API. In AI Studio, you can enable code execution in the right panel under Tools. The Gemini API provides code execution as a tool, similar to function calling. After you add code execution as a tool, the model decides when to use it.

The code execution environment includes the following libraries: altair, chess, cv2, matplotlib, mpmath, numpy, pandas, pdfminer, reportlab, seaborn, sklearn, statsmodels, striprtf, sympy, and tabulate. You can't install your own libraries. Note: Only matplotlib is supported for graph rendering using code execution. Before you begin

Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Get started with code execution

You can also try the code execution tutorial in a notebook:

View on ai.google.dev

Try a Colab notebook

View notebook on GitHub

Enable code execution on the model

You can enable code execution on the model, as shown here:

from google import genai from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content( model='gemini-2.0-flash', contents='What is the sum of the first 50 prime numbers? ' 'Generate and run code for the calculation, and make sure you get all 50.', config=types.GenerateContentConfig( tools=[types.Tool( code_execution=types.ToolCodeExecution )] ) )

In a notebook you can display everything in Markdown format with this helper function:

def display_code_execution_result(response): for part in response.candidates[0].content.parts: if part.text is not None: display(Markdown(part.text)) if part.executable_code is not None: code_html = f'<pre style="background-color: #BBBBEE;">{part.executable_code.code}</pre>' # Change code color display(HTML(code_html)) if part.code_execution_result is not None: display(Markdown(part.code_execution_result.output)) if part.inline_data is not None: display(Image(data=part.inline_data.data, format="png")) display(Markdown("---"))

display_code_execution_result(response)

The output might look something like this:

Okay, I need to calculate the sum of the first 50 prime numbers. I will use a python script to generate the first 50 primes and then sum them up.

```python def is_prime(n): """Checks if a number is prime.""" if n

Use code execution in chat

You can also use code execution as part of a chat.

from google import genai from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

chat = client.chats.create( model='gemini-2.0-flash', config=types.GenerateContentConfig( tools=[types.Tool( code_execution=types.ToolCodeExecution )] ) )

response = chat.send_message("Can you run some code to bogo-sort this list of numbers?: [2,34,1,65,4]") display_code_execution_result(response)

The conversation could continue like this:

I understand that you want me to bogo-sort the list [2, 34, 1, 65, 4]. Bogo-sort is a notoriously inefficient sorting algorithm. It works by repeatedly shuffling the list until it happens to be sorted. Due to its extremely poor performance, it's impractical for lists of any significant size.

However, for demonstration purposes, I can run a simplified version for a very limited number of iterations, just to show the process. Should I go ahead?

response = chat.send_message("Yes, please create the code.") display_code_execution_result(response)

Okay,I will proceed with a function that shuffles the list and checks if it's sorted. I'll run it for a maximum of 10 iterations. ...

Input/output (I/O)

Starting with Gemini 2.0 Flash, code execution supports file input and graph output. Using these new input and output capabilities, you can upload CSV and text files, ask questions about the files, and have Matplotlib graphs generated as part of the response.

I/O pricing

When using code execution I/O, you're charged for input tokens and output tokens:

Input tokens:

User prompt

Output tokens:

Code generated by the model Code execution output in the code environment Summary generated by the model

I/O details

When you're working with code execution I/O, be aware of the following technical details:

The maximum runtime of the code environment is 30 seconds. If the code environment generates an error, the model may decide to regenerate the code output. This can happen up to 5 times. The maximum file input size is limited by the model token window. In AI Studio, using Gemini Flash 2.0, the maximum input file size is 1 million tokens (roughly 2MB for text files of the supported input types). If you upload a file that's too large, AI Studio won't let you send it.

Single turn Bidirectional (Multimodal Live API)

Models supported All Gemini 2.0 models Only Flash experimental models

File input types supported .png, .jpeg, .csv, .xml, .cpp, .java, .py, .js, .ts .png, .jpeg, .csv, .xml, .cpp, .java, .py, .js, .ts

Plotting libraries supported Matplotlib Matplotlib

Multi-tool use No Yes


Function Calling with the Gemini API

Function calling lets you connect models to external tools and APIs. Instead of generating text responses, the model understands when to call specific functions and provides the necessary parameters to execute real-world actions. This allows the model to act as a bridge between natural language and real-world actions and data. Function calling has 3 primary use cases:

Augment Knowledge: Access information from external sources like databases, APIs, and knowledge bases.

Extend Capabilities: Use external tools to perform computations and extend the limitations of the model, such as using a calculator or creating charts.

Take Actions: Interact with external systems using APIs, such as scheduling appointments, creating invoices, sending emails, or controlling smart home devices

Get Weather Schedule Meeting Create Chart

Python

from google import genai from google.genai import types

# Define the function declaration for the model schedule_meeting_function = { "name": "schedule_meeting", "description": "Schedules a meeting with specified attendees at a given time and date.", "parameters": { "type": "object", "properties": { "attendees": { "type": "array", "items": {"type": "string"}, "description": "List of people attending the meeting.", }, "date": { "type": "string", "description": "Date of the meeting (e.g., '2024-07-29')", }, "time": { "type": "string", "description": "Time of the meeting (e.g., '15:00')", }, "topic": { "type": "string", "description": "The subject or topic of the meeting.", }, }, "required": ["attendees", "date", "time", "topic"], }, }

# Configure the client and tools client = genai.Client(api_key=os.getenv("GEMINI_API_KEY")) tools = types.Tool(function_declarations=[schedule_meeting_function]) config = types.GenerateContentConfig(tools=[tools])

# Send request with function declarations response = client.models.generate_content( model="gemini-2.0-flash", contents="Schedule a meeting with Bob and Alice for 03/14/2025 at 10:00 AM about the Q3 planning.", config=config, )

# Check for a function call if response.candidates[0].content.parts[0].function_call: function_call = response.candidates[0].content.parts[0].function_call print(f"Function to call: {function_call.name}") print(f"Arguments: {function_call.args}") # In a real app, you would call your function here: # result = schedule_meeting(**function_call.args) else: print("No function call found in the response.") print(response.text)

JavaScript

import { GoogleGenAI, Type } from '@google/genai';

// Configure the client const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define the function declaration for the model const scheduleMeetingFunctionDeclaration = { name: 'schedule_meeting', description: 'Schedules a meeting with specified attendees at a given time and date.', parameters: { type: Type.OBJECT, properties: { attendees: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of people attending the meeting.', }, date: { type: Type.STRING, description: 'Date of the meeting (e.g., "2024-07-29")', }, time: { type: Type.STRING, description: 'Time of the meeting (e.g., "15:00")', }, topic: { type: Type.STRING, description: 'The subject or topic of the meeting.', }, }, required: ['attendees', 'date', 'time', 'topic'], }, };

// Send request with function declarations const response = await ai.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Schedule a meeting with Bob and Alice for 03/27/2025 at 10:00 AM about the Q3 planning.', config: { tools: [{ functionDeclarations: [scheduleMeetingFunctionDeclaration] }], }, });

// Check for function calls in the response if (response.functionCalls && response.functionCalls.length > 0) { const functionCall = response.functionCalls[0]; // Assuming one function call console.log(`Function to call: ${functionCall.name}`); console.log(`Arguments: ${JSON.stringify(functionCall.args)}`); // In a real app, you would call your actual function here: // const result = await scheduleMeeting(functionCall.args); } else { console.log("No function call found in the response."); console.log(response.text); }

REST

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=$GEMINI_API_KEY" \ -H 'Content-Type: application/json' \ -X POST \ -d '{ "contents": [ { "role": "user", "parts": [ { "text": "Schedule a meeting with Bob and Alice for 03/27/2025 at 10:00 AM about the Q3 planning." } ] } ], "tools": [ { "functionDeclarations": [ { "name": "schedule_meeting", "description": "Schedules a meeting with specified attendees at a given time and date.", "parameters": { "type": "object", "properties": { "attendees": { "type": "array", "items": {"type": "string"}, "description": "List of people attending the meeting." }, "date": { "type": "string", "description": "Date of the meeting (e.g., '2024-07-29')" }, "time": { "type": "string", "description": "Time of the meeting (e.g., '15:00')" }, "topic": { "type": "string", "description": "The subject or topic of the meeting." } }, "required": ["attendees", "date", "time", "topic"] } } ] } ] }'

How Function Calling Works

Function calling involves a structured interaction between your application, the model, and external functions. Here's a breakdown of the process:

Define Function Declaration: Define the function declaration in your application code. Function Declarations describe the function's name, parameters, and purpose to the model.

Call LLM with function declarations: Send user prompt along with the function declaration(s) to the model. It analyzes the request and determines if a function call would be helpful. If so, it responds with a structured JSON object.

Execute Function Code (Your Responsibility): The Model does not execute the function itself. It's your application's responsibility to process the response and check for Function Call, if

Yes: Extract the name and args of the function and execute the corresponding function in your application.

No: The model has provided a direct text response to the prompt (this flow is less emphasized in the example but is a possible outcome).

Create User friendly response: If a function was executed, capture the result and send it back to the model in a subsequent turn of the conversation. It will use the result to generate a final, user-friendly response that incorporates the information from the function call.

This process can be repeated over multiple turns, allowing for complex interactions and workflows. The model also supports calling multiple functions in a single turn (parallel function calling) and in sequence (compositional function calling).

Step 1: Define Function Declaration

Define a function and its declaration within your application code that allows users to set light values and make an API request. This function could call external services or APIs.

Python

from google.genai import types

# Define a function that the model can call to control smart lights set_light_values_declaration = { "name": "set_light_values", "description": "Sets the brightness and color temperature of a light.", "parameters": { "type": "object", "properties": { "brightness": { "type": "integer", "description": "Light level from 0 to 100. Zero is off and 100 is full brightness", }, "color_temp": { "type": "string", "enum": ["daylight", "cool", "warm"], "description": "Color temperature of the light fixture, which can be `daylight`, `cool` or `warm`.", }, }, "required": ["brightness", "color_temp"], }, }

# This is the actual function that would be called based on the model's suggestion def set_light_values(brightness: int, color_temp: str) -> dict[str, int | str]: """Set the brightness and color temperature of a room light. (mock API).

Args: brightness: Light level from 0 to 100. Zero is off and 100 is full brightness color_temp: Color temperature of the light fixture, which can be `daylight`, `cool` or `warm`.

Returns: A dictionary containing the set brightness and color temperature. """ return {"brightness": brightness, "colorTemperature": color_temp}

JavaScript

import { Type } from '@google/genai';

// Define a function that the model can call to control smart lights const setLightValuesFunctionDeclaration = { name: 'set_light_values', description: 'Sets the brightness and color temperature of a light.', parameters: { type: Type.OBJECT, properties: { brightness: { type: Type.NUMBER, description: 'Light level from 0 to 100. Zero is off and 100 is full brightness', }, color_temp: { type: Type.STRING, enum: ['daylight', 'cool', 'warm'], description: 'Color temperature of the light fixture, which can be `daylight`, `cool` or `warm`.', }, }, required: ['brightness', 'color_temp'], }, };

/** * Set the brightness and color temperature of a room light. (mock API) * @param {number} brightness - Light level from 0 to 100. Zero is off and 100 is full brightness * @param {string} color_temp - Color temperature of the light fixture, which can be `daylight`, `cool` or `warm`. * @return {Object} A dictionary containing the set brightness and color temperature. */ function setLightValues(brightness, color_temp) { return { brightness: brightness, colorTemperature: color_temp }; }

Step 2: Call the model with function declarations

Once you have defined your function declarations, you can prompt the model to use the function. It analyzes the prompt and function declarations and decides to respond directly or to call a function. If a function is called the response object will contain a function call suggestion.

Python

from google import genai

# Generation Config with Function Declaration tools = types.Tool(function_declarations=[set_light_values_declaration]) config = types.GenerateContentConfig(tools=[tools])

# Configure the client client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Define user prompt contents = [ types.Content( role="user", parts=[types.Part(text="Turn the lights down to a romantic level")] ) ]

# Send request with function declarations response = client.models.generate_content( model="gemini-2.0-flash", config=config, contents=contents )

print(response.candidates[0].content.parts[0].function_call)

JavaScript

import { GoogleGenAI } from '@google/genai';

// Generation Config with Function Declaration const config = { tools: [{ functionDeclarations: [setLightValuesFunctionDeclaration] }] };

// Configure the client const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Define user prompt const contents = [ { role: 'user', parts: [{ text: 'Turn the lights down to a romantic level' }] } ];

// Send request with function declarations const response = await ai.models.generateContent({ model: 'gemini-2.0-flash', contents: contents, config: config });

console.log(response.functionCalls[0]);

The model then returns a functionCall object in an OpenAPI compatible schema specifying how to call one or more of the declared functions in order to respond to the user's question.

Python

id=None args={'color_temp': 'warm', 'brightness': 25} name='set_light_values'

JavaScript

{ name: 'set_light_values', args: { brightness: 25, color_temp: 'warm' } }

Step 3: Execute set_light_values function code

Extract the function call details from the model's response, parse the arguments , and execute the set_light_values function in our code.

Python

# Extract tool call details tool_call = response.candidates[0].content.parts[0].function_call

if tool_call.name == "set_light_values": result = set_light_values(**tool_call.args) print(f"Function execution result: {result}")

JavaScript

// Extract tool call details const tool_call = response.functionCalls[0]

let result; if (tool_call.name === 'set_light_values') { result = setLightValues(tool_call.args.brightness, tool_call.args.color_temp); console.log(`Function execution result: ${JSON.stringify(result)}`); }

Step 4: Create User friendly response with function result and call the model again

Finally, send the result of the function execution back to the model so it can incorporate this information into its final response to the user.

Python

# Create a function response part function_response_part = types.Part.from_function_response( name=tool_call.name, response={"result": result}, )

# Append function call and result of the function execution to contents contents.append(types.Content(role="model", parts=[types.Part(function_call=tool_call)])) # Append the model's function call message contents.append(types.Content(role="user", parts=[function_response_part])) # Append the function response

final_response = client.models.generate_content( model="gemini-2.0-flash", config=config, contents=contents, )

print(final_response.text)

JavaScript

// Create a function response part const function_response_part = { name: tool_call.name, response: { result } }

// Append function call and result of the function execution to contents contents.push({ role: 'model', parts: [{ functionCall: tool_call }] }); contents.push({ role: 'user', parts: [{ functionResponse: function_response_part }] });

// Get the final response from the model const final_response = await ai.models.generateContent({ model: 'gemini-2.0-flash', contents: contents, config: config });

console.log(final_response.text);

This completes the function calling flow. The Model successfully used the set_light_values function to perform the request action of the user.

Function declarations

When you implement function calling in a prompt, you create a tools object, which contains one or more function declarations. You define functions using JSON, specifically with a select subset of the OpenAPI schema format. A single function declaration can include the following parameters:

name (string): A unique name for the function (get_weather_forecast, send_email). Use descriptive names without spaces or special characters (use underscores or camelCase).

description (string): A clear and detailed explanation of the function's purpose and capabilities. This is crucial for the model to understand when to use the function. Be specific and provide examples if helpful ("Finds theaters based on location and optionally movie title which is currently playing in theaters.").

parameters (object): Defines the input parameters the function expects.

type (string): Specifies the overall data type, such as object.

properties (object): Lists individual parameters, each with:

type (string): The data type of the parameter, such as string, integer, boolean, array.

description (string): A description of the parameter's purpose and format. Provide examples and constraints ("The city and state, e.g., 'San Francisco, CA' or a zip code e.g., '95616'.").

enum (array, optional): If the parameter values are from a fixed set, use "enum" to list the allowed values instead of just describing them in the description. This improves accuracy ("enum": ["daylight", "cool", "warm"]).

required (array): An array of strings listing the parameter names that are mandatory for the function to operate.

Parallel Function Calling

In addition to single turn function calling, you can also call multiple functions at once. Parallel function calling lets you execute multiple functions at once and is used when the functions are not dependent on each other. This is useful in scenarios like gathering data from multiple independent sources, such as retrieving customer details from different databases or checking inventory levels across various warehouses or performing multiple actions such as converting your apartment into a disco.

Python

power_disco_ball = { "name": "power_disco_ball", "description": "Powers the spinning disco ball.", "parameters": { "type": "object", "properties": { "power": { "type": "boolean", "description": "Whether to turn the disco ball on or off.", } }, "required": ["power"], }, }

start_music = { "name": "start_music", "description": "Play some music matching the specified parameters.", "parameters": { "type": "object", "properties": { "energetic": { "type": "boolean", "description": "Whether the music is energetic or not.", }, "loud": { "type": "boolean", "description": "Whether the music is loud or not.", }, }, "required": ["energetic", "loud"], }, }

dim_lights = { "name": "dim_lights", "description": "Dim the lights.", "parameters": { "type": "object", "properties": { "brightness": { "type": "number", "description": "The brightness of the lights, 0.0 is off, 1.0 is full.", } }, "required": ["brightness"], }, }

JavaScript

import { Type } from '@google/genai';

const powerDiscoBall = { name: 'power_disco_ball', description: 'Powers the spinning disco ball.', parameters: { type: Type.OBJECT, properties: { power: { type: Type.BOOLEAN, description: 'Whether to turn the disco ball on or off.' } }, required: ['power'] } };

const startMusic = { name: 'start_music', description: 'Play some music matching the specified parameters.', parameters: { type: Type.OBJECT, properties: { energetic: { type: Type.BOOLEAN, description: 'Whether the music is energetic or not.' }, loud: { type: Type.BOOLEAN, description: 'Whether the music is loud or not.' } }, required: ['energetic', 'loud'] } };

const dimLights = { name: 'dim_lights', description: 'Dim the lights.', parameters: { type: Type.OBJECT, properties: { brightness: { type: Type.NUMBER, description: 'The brightness of the lights, 0.0 is off, 1.0 is full.' } }, required: ['brightness'] } };

Call the model with an instruction that could use all of the specified tools. This example uses a tool_config. To learn more you can read about configuring function calling.

Python

from google import genai from google.genai import types

# Set up function declarations house_tools = [ types.Tool(function_declarations=[power_disco_ball, start_music, dim_lights]) ]

config = { "tools": house_tools, "automatic_function_calling": {"disable": True}, # Force the model to call 'any' function, instead of chatting. "tool_config": {"function_calling_config": {"mode": "any"}}, }

# Configure the client client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

chat = client.chats.create(model="gemini-2.0-flash", config=config) response = chat.send_message("Turn this place into a party!")

# Print out each of the function calls requested from this single call print("Example 1: Forced function calling") for fn in response.function_calls: args = ", ".join(f"{key}={val}" for key, val in fn.args.items()) print(f"{fn.name}({args})")

JavaScript

import { GoogleGenAI } from '@google/genai';

// Set up function declarations const houseFns = [powerDiscoBall, startMusic, dimLights];

const config = { tools: [{ functionDeclarations: houseFns }], // Force the model to call 'any' function, instead of chatting. toolConfig: { functionCallingConfig: { mode: 'any' } } };

// Configure the client const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Create a chat session const chat = ai.chats.create({ model: 'gemini-2.0-flash', config: config }); const response = await chat.sendMessage({message: 'Turn this place into a party!'});

// Print out each of the function calls requested from this single call console.log("Example 1: Forced function calling"); for (const fn of response.functionCalls) { const args = Object.entries(fn.args) .map(([key, val]) => `${key}=${val}`) .join(', '); console.log(`${fn.name}(${args})`); }

Each of the printed results reflects a single function call that the model has requested. To send the results back, include the responses in the same order as they were requested.

The Python SDK supports a feature called automatic function calling which converts the Python function to declarations, handles the function call execution and response cycle for you. Following is an example for our disco use case. Note: Automatic Function Calling is a Python SDK only feature at the moment. Python

from google import genai from google.genai import types

# Actual implementation functions def power_disco_ball_impl(power: bool) -> dict: """Powers the spinning disco ball.

Args: power: Whether to turn the disco ball on or off.

Returns: A status dictionary indicating the current state. """ return {"status": f"Disco ball powered {'on' if power else 'off'}"}

def start_music_impl(energetic: bool, loud: bool) -> dict: """Play some music matching the specified parameters.

Args: energetic: Whether the music is energetic or not. loud: Whether the music is loud or not.

Returns: A dictionary containing the music settings. """ music_type = "energetic" if energetic else "chill" volume = "loud" if loud else "quiet" return {"music_type": music_type, "volume": volume}

def dim_lights_impl(brightness: float) -> dict: """Dim the lights.

Args: brightness: The brightness of the lights, 0.0 is off, 1.0 is full.

Returns: A dictionary containing the new brightness setting. """ return {"brightness": brightness}

config = { "tools": [power_disco_ball_impl, start_music_impl, dim_lights_impl], }

chat = client.chats.create(model="gemini-2.0-flash", config=config) response = chat.send_message("Do everything you need to this place into party!")

print("\nExample 2: Automatic function calling") print(response.text) # I've turned on the disco ball, started playing loud and energetic music, and dimmed the lights to 50% brightness. Let's get this party started!

Compositional Function Calling

Gemini 2.0 supports compositional function calling, meaning the model can chain multiple function calls together. For example, to answer "Get the temperature in my current location", the Gemini API might invoke both a get_current_location() function and a get_weather() function that takes the location as a parameter. Note: Compositional function calling is a Live API only feature at the moment. The run() function declaration, which handles the asynchronous websocket setup, is omitted for brevity. Python

# Light control schemas turn_on_the_lights_schema = {'name': 'turn_on_the_lights'} turn_off_the_lights_schema = {'name': 'turn_off_the_lights'}

prompt = """ Hey, can you write run some python code to turn on the lights, wait 10s and then turn off the lights? """

tools = [ {'code_execution': {}}, {'function_declarations': [turn_on_the_lights_schema, turn_off_the_lights_schema]} ]

await run(prompt, tools=tools, modality="AUDIO")

JavaScript

// Light control schemas const turnOnTheLightsSchema = { name: 'turn_on_the_lights' }; const turnOffTheLightsSchema = { name: 'turn_off_the_lights' };

const prompt = ` Hey, can you write run some python code to turn on the lights, wait 10s and then turn off the lights? `;

const tools = [ { codeExecution: {} }, { functionDeclarations: [turnOnTheLightsSchema, turnOffTheLightsSchema] } ];

await run(prompt, tools=tools, modality="AUDIO")

Function calling modes

The Gemini API lets you control how the model uses the provided tools (function declarations). Specifically, you can set the mode within the function_calling_config.

AUTO (Default): The model decides whether to generate a natural language response or suggest a function call based on the prompt and context. This is the most flexible mode and recommended for most scenarios.

ANY: The model is constrained to always predict a function call and guarantee function schema adherence. If allowed_function_names is not specified, the model can choose from any of the provided function declarations. If allowed_function_names is provided as a list, the model can only choose from the functions in that list. Use this mode when you require a function call in response to every prompt (if applicable). NONE: The model is prohibited from making function calls. This is equivalent to sending a request without any function declarations. Use this to temporarily disable function calling without removing your tool definitions.

Python

from google.genai import types

# Configure function calling mode tool_config = types.ToolConfig( function_calling_config=types.FunctionCallingConfig( mode="ANY", allowed_function_names=["get_current_temperature"] ) )

# Create the generation config config = types.GenerateContentConfig( temperature=0, tools=[tools], # not defined here. tool_config=tool_config, )

JavaScript

import { FunctionCallingConfigMode } from '@google/genai';

// Configure function calling mode const toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['get_current_temperature'] } };

// Create the generation config const config = { temperature: 0, tools: tools, // not defined here. toolConfig: toolConfig, };

Automatic Function Calling (Python Only)

When using the Python SDK, you can provide Python functions directly as tools. The SDK automatically converts the Python function to declarations, handles the function call execution and response cycle for you. The Python SDK then automatically:

Detects function call responses from the model. Call the corresponding Python function in your code. Sends the function response back to the model. Returns the model's final text response.

To use this, define your function with type hints and a docstring, and then pass the function itself (not a JSON declaration) as a tool:

Python

from google import genai from google.genai import types

# Define the function with type hints and docstring def get_current_temperature(location: str) -> dict: """Gets the current temperature for a given location.

Args: location: The city and state, e.g. San Francisco, CA

Returns: A dictionary containing the temperature and unit. """ # ... (implementation) ... return {"temperature": 25, "unit": "Celsius"}

# Configure the client and model client = genai.Client(api_key=os.getenv("GEMINI_API_KEY")) # Replace with your actual API key setup config = types.GenerateContentConfig( tools=[get_current_temperature] ) # Pass the function itself

# Make the request response = client.models.generate_content( model="gemini-2.0-flash", contents="What's the temperature in Boston?", config=config, )

print(response.text) # The SDK handles the function call and returns the final text

You can disable automatic function calling with:

Python

# To disable automatic function calling: config = types.GenerateContentConfig( tools=[get_current_temperature], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True) )

Automatic Function schema declaration

Automatic schema extraction from Python functions doesn't work in all cases. For example: it doesn't handle cases where you describe the fields of a nested dictionary-object. The API is able to describe any of the following types:

Python

AllowedType = (int | float | bool | str | list['AllowedType'] | dict[str, AllowedType])

To see what the inferred schema looks like, you can convert it using from_callable:

Python

def multiply(a: float, b: float): """Returns a * b.""" return a * b

fn_decl = types.FunctionDeclaration.from_callable(callable=multiply, client=client)

# to_json_dict() provides a clean JSON representation. print(fn_decl.to_json_dict())

Multi-tool use: Combine Native Tools with Function Calling

With Gemini 2.0, you can enable multiple tools combining native tools with function calling at the same time. Here's an example that enables two tools, Grounding with Google Search and code execution, in a request using the Live API. Note: Multi-tool use is a Live API only feature at the moment. The run() function declaration, which handles the asynchronous websocket setup, is omitted for brevity. Python

# Multiple tasks example - combining lights, code execution, and search prompt = """ Hey, I need you to do three things for me.

1. Turn on the lights. 2. Then compute the largest prime palindrome under 100000. 3. Then use Google Search to look up information about the largest earthquake in California the week of Dec 5 2024.

Thanks! """

tools = [ {'google_search': {}}, {'code_execution': {}}, {'function_declarations': [turn_on_the_lights_schema, turn_off_the_lights_schema]} # not defined here. ]

# Execute the prompt with specified tools in audio modality await run(prompt, tools=tools, modality="AUDIO")

JavaScript

// Multiple tasks example - combining lights, code execution, and search const prompt = ` Hey, I need you to do three things for me.

1. Turn on the lights. 2. Then compute the largest prime palindrome under 100000. 3. Then use Google Search to look up information about the largest earthquake in California the week of Dec 5 2024.

Thanks! `;

const tools = [ { googleSearch: {} }, { codeExecution: {} }, { functionDeclarations: [turnOnTheLightsSchema, turnOffTheLightsSchema] } // not defined here. ];

// Execute the prompt with specified tools in audio modality await run(prompt, {tools: tools, modality: "AUDIO"});

Python developers can try this out in the Live API Tool Use notebook.

Use Model Context Protocol (MCP)

Model Context Protocol (MCP) is an open standard to connect AI applications with external tools, data sources, and systems. MCP provides a common protocol for models to access context, such as functions (tools), data sources (resources), or predefined prompts. You can use models with MCP server using their tool calling capabilities.

MCP servers expose the tools as JSON schema definitions, which can be used with Gemini compatible function declarations. This lets you to use a MCP server with Gemini models directly. Here, you can find an example of how to use a local MCP server with Gemini SDK and the mcp SDK.

Python

import asyncio import os from datetime import datetime from google import genai from google.genai import types from mcp import ClientSession, StdioServerParameters from mcp.client.stdio import stdio_client

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Create server parameters for stdio connection server_params = StdioServerParameters( command="npx", # Executable args=["-y", "@philschmid/weather-mcp"], # Weather MCP Server env=None, # Optional environment variables )

async def run(): async with stdio_client(server_params) as (read, write): async with ClientSession(read, write) as session: # Prompt to get the weather for the current day in London. prompt = f"What is the weather in London in {datetime.now().strftime('%Y-%m-%d')}?" # Initialize the connection between client and server await session.initialize()

# Get tools from MCP session and convert to Gemini Tool objects mcp_tools = await session.list_tools() tools = [ types.Tool( function_declarations=[ { "name": tool.name, "description": tool.description, "parameters": { k: v for k, v in tool.inputSchema.items() if k not in ["additionalProperties", "$schema"] }, } ] ) for tool in mcp_tools.tools ]

# Send request to the model with MCP function declarations response = client.models.generate_content( model="gemini-2.0-flash", contents=prompt, config=types.GenerateContentConfig( temperature=0, tools=tools, ), )

# Check for a function call if response.candidates[0].content.parts[0].function_call: function_call = response.candidates[0].content.parts[0].function_call print(function_call) # Call the MCP server with the predicted tool result = await session.call_tool( function_call.name, arguments=function_call.args ) print(result.content[0].text) # Continue as shown in step 4 of "How Function Calling Works" # and create a user friendly response else: print("No function call found in the response.") print(response.text)

# Start the asyncio event loop and run the main function asyncio.run(run())

JavaScript

import { GoogleGenAI } from '@google/genai'; import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Create server parameters for stdio connection const serverParams = new StdioClientTransport({ command: "npx", args: ["-y", "@philschmid/weather-mcp"] });

const client = new Client( { name: "example-client", version: "1.0.0" } );

// Configure the client const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize the connection between client and server await client.connect(serverParams);

// Get tools from MCP session and convert to Gemini Tool objects const mcpTools = await client.listTools(); const tools = mcpTools.tools.map((tool) => { // Filter the parameters to exclude not supported keys const parameters = Object.fromEntries( Object.entries(tool.inputSchema).filter(([key]) => !["additionalProperties", "$schema"].includes(key)) ); return { name: tool.name, description: tool.description, parameters: parameters }; });

// Send request to the model with MCP function declarations const response = await ai.models.generateContent({ model: "gemini-2.0-flash", contents: "What is the weather in London in the UK on 2024-04-04?", config: { tools: [{ functionDeclarations: tools }], }, });

// Check for function calls in the response if (response.functionCalls && response.functionCalls.length > 0) { const functionCall = response.functionCalls[0]; // Assuming one function call console.log(`Function to call: ${functionCall.name}`); console.log(`Arguments: ${JSON.stringify(functionCall.args)}`); // Call the MCP server with the predicted tool const result = await client.callTool({name: functionCall.name, arguments: functionCall.args}); console.log(result.content[0].text); // Continue as shown in step 4 of "How Function Calling Works" // and create a user friendly response } else { console.log("No function call found in the response."); console.log(response.text); }

// Close the connection await client.close();


The Gemini API supports PDF input, including long documents (up to 3600 pages). Gemini models process PDFs with native vision, and are therefore able to understand both text and image contents inside documents. With native PDF vision support, Gemini models are able to:

Analyze diagrams, charts, and tables inside documents. Extract information into structured output formats. Answer questions about visual and text contents in documents. Summarize documents. Transcribe document content (e.g. to HTML) preserving layouts and formatting, for use in downstream applications (such as in RAG pipelines).

This tutorial demonstrates some possible ways to use the Gemini API with PDF documents. All output is text-only.

Before you begin

Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Prompting with PDFs

This guide demonstrates how to upload and process PDFs using the File API or by including them as inline data.

Technical details

Gemini 1.5 Pro and 1.5 Flash support a maximum of 3,600 document pages. Document pages must be in one of the following text data MIME types:

PDF - application/pdf

JavaScript - application/x-javascript, text/javascript

Python - application/x-python, text/x-python

TXT - text/plain

HTML - text/html

CSS - text/css

Markdown - text/md

CSV - text/csv

XML - text/xml

RTF - text/rtf

Each document page is equivalent to 258 tokens.

While there are no specific limits to the number of pixels in a document besides the model's context window, larger pages are scaled down to a maximum resolution of 3072x3072 while preserving their original aspect ratio, while smaller pages are scaled up to 768x768 pixels. There is no cost reduction for pages at lower sizes, other than bandwidth, or performance improvement for pages at higher resolution.

For best results:

Rotate pages to the correct orientation before uploading. Avoid blurry pages. If using a single page, place the text prompt after the page.

PDF input

For PDF payloads under 20MB, you can choose between uploading base64 encoded documents or directly uploading locally stored files.

As inline data

You can process PDF documents directly from URLs. Here's a code snippet showing how to do this:

from google import genai from google.genai import types import httpx

client = genai.Client()

doc_url = "https://discovery.ucl.ac.uk/id/eprint/10089234/1/343019_3_art_0_py4t4l_convrt.pdf" # Replace with the actual URL of your PDF

# Retrieve and encode the PDF byte doc_data = httpx.get(doc_url).content

prompt = "Summarize this document" response = client.models.generate_content( model="gemini-1.5-flash", contents=[ types.Part.from_bytes( data=doc_data, mime_type='application/pdf', ), prompt]) print(response.text)

Locally stored PDFs

For locally stored PDFs, you can use the following approach:

from google import genai from google.genai import types import pathlib import httpx

client = genai.Client()

doc_url = "https://discovery.ucl.ac.uk/id/eprint/10089234/1/343019_3_art_0_py4t4l_convrt.pdf" # Replace with the actual URL of your PDF

# Retrieve and encode the PDF byte filepath = pathlib.Path('file.pdf') filepath.write_bytes(httpx.get(doc_url).content)

prompt = "Summarize this document" response = client.models.generate_content( model="gemini-1.5-flash", contents=[ types.Part.from_bytes( data=filepath.read_bytes(), mime_type='application/pdf', ), prompt]) print(response.text)

Large PDFs

You can use the File API to upload a document of any size. Always use the File API when the total request size (including the files, text prompt, system instructions, etc.) is larger than 20 MB. Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but cannot be downloaded from the API. The File API is available at no cost in all regions where the Gemini API is available. Call media.upload to upload a file using the File API. The following code uploads a document file and then uses the file in a call to models.generateContent.

Large PDFs from URLs

Use the File API for large PDF files available from URLs, simplifying the process of uploading and processing these documents directly through their URLs:

from google import genai from google.genai import types import io import httpx

client = genai.Client()

long_context_pdf_path = "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a17/A17_FlightPlan.pdf" # Replace with the actual URL of your large PDF

# Retrieve and upload the PDF using the File API doc_io = io.BytesIO(httpx.get(long_context_pdf_path).content)

sample_doc = client.files.upload( # You can pass a path or a file-like object here file=doc_io, config=dict( # It will guess the mime type from the file extension, but if you pass # a file-like object, you need to set the mime_type='application/pdf') )

prompt = "Summarize this document"

response = client.models.generate_content( model="gemini-1.5-flash", contents=[sample_doc, prompt]) print(response.text)

Large PDFs stored locally

from google import genai from google.genai import types import pathlib import httpx

client = genai.Client()

long_context_pdf_path = "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a17/A17_FlightPlan.pdf" # Replace with the actual URL of your large PDF

# Retrieve the PDF file_path = pathlib.Path('A17.pdf') file_path.write_bytes(httpx.get(long_context_pdf_path).content)

# Upload the PDF using the File API sample_file = client.files.upload( file=file_path, )

prompt="Summarize this document"

response = client.models.generate_content( model="gemini-1.5-flash", contents=[sample_file, "Summarize this document"]) print(response.text)

You can verify the API successfully stored the uploaded file and get its metadata by calling files.get. Only the name (and by extension, the uri) are unique.

from google import genai import pathlib

client = genai.Client()

fpath = pathlib.Path('example.txt') fpath.write_text('hello')

file = client.files.upload('example.txt')

file_info = client.files.get(file.name) print(file_info.model_dump_json(indent=4))

Multiple PDFs

The Gemini API is capable of processing multiple PDF documents in a single request, as long as the combined size of the documents and the text prompt stays within the model's context window.

from google import genai import io import httpx

client = genai.Client()

doc_url_1 = "https://arxiv.org/pdf/2312.11805" # Replace with the URL to your first PDF doc_url_2 = "https://arxiv.org/pdf/2403.05530" # Replace with the URL to your second PDF

# Retrieve and upload both PDFs using the File API doc_data_1 = io.BytesIO(httpx.get(doc_url_1).content) doc_data_2 = io.BytesIO(httpx.get(doc_url_2).content)

sample_pdf_1 = client.files.upload( file=doc_data_1, config=dict(mime_type='application/pdf') ) sample_pdf_2 = client.files.upload( file=doc_data_2, config=dict(mime_type='application/pdf') )

prompt = "What is the difference between each of the main benchmarks between these two papers? Output these in a table."

response = client.models.generate_content( model="gemini-1.5-flash", contents=[sample_pdf_1, sample_pdf_2, prompt]) print(response.text)

List files

You can list all files uploaded using the File API and their URIs using files.list.

from google import genai

client = genai.Client()

print("My files:") for f in client.files.list(): print(" ", f.name)

Delete files

Files uploaded using the File API are automatically deleted after 2 days. You can also manually delete them using files.delete.

from google import genai import pathlib

client = genai.Client()

fpath = pathlib.Path('example.txt') fpath.write_text('hello')

file = client.files.upload('example.txt')

client.files.delete(file.name)

Context caching with PDFs

from google import genai from google.genai import types import io import httpx

client = genai.Client()

long_context_pdf_path = "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a17/A17_FlightPlan.pdf" # Replace with the actual URL of your large PDF

# Retrieve and upload the PDF using the File API doc_io = io.BytesIO(httpx.get(long_context_pdf_path).content)

document = client.files.upload( file=doc_io, config=dict(mime_type='application/pdf') )

# Specify the model name and system instruction for caching model_name = "gemini-1.5-flash-002" # Ensure this matches the model you intend to use system_instruction = "You are an expert analyzing transcripts."

# Create a cached content object cache = client.caches.create( model=model_name, config=types.CreateCachedContentConfig( system_instruction=system_instruction, contents=[document], # The document(s) and other content you wish to cache ) )

# Display the cache details print(f'{cache=}')

# Generate content using the cached prompt and document response = client.models.generate_content( model=model_name, contents="Please summarize this transcript", config=types.GenerateContentConfig( cached_content=cache.name ))

# (Optional) Print usage metadata for insights into the API call print(f'{response.usage_metadata=}')

# Print the generated text print('\n\n', response.text)

List caches

It's not possible to retrieve or view cached content, but you can retrieve cache metadata (name, model, display_name, usage_metadata, create_time, update_time, and expire_time).

To list metadata for all uploaded caches, use CachedContent.list():

from google import genai

client = genai.Client() for c in client.caches.list(): print(c)

Update a cache

You can set a new ttl or expire_time for a cache. Changing anything else about the cache isn't supported.

The following example shows how to update the ttl of a cache using CachedContent.update().

from google import genai from google.genai import types import datetime

client = genai.Client()

model_name = "models/gemini-1.5-flash-002"

cache = client.caches.create( model=model_name, config=types.CreateCachedContentConfig( contents=['hello'] ) )

client.caches.update( name = cache.name, config=types.UpdateCachedContentConfig( ttl=f'{datetime.timedelta(hours=2).total_seconds()}s' ) )

Delete a cache

The caching service provides a delete operation for manually removing content from the cache. The following example shows how to delete a cache using CachedContent.delete().

from google import genai from google.genai import types import datetime

client = genai.Client()

model_name = "models/gemini-1.5-flash-002"

cache = client.caches.create( model=model_name, config=types.CreateCachedContentConfig( contents=['hello'] ) )

client.caches.delete(name = cache.name)



The Grounding with Google Search feature in the Gemini API and AI Studio can be used to improve the accuracy and recency of responses from the model. In addition to more factual responses, when Grounding with Google Search is enabled, the Gemini API returns grounding sources (in-line supporting links) and Google Search Suggestions along with the response content. The Search Suggestions point users to the search results corresponding to the grounded response.

This guide will help you get started with Grounding with Google Search.

Before you begin

Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Configure Search Grounding

Starting with Gemini 2.0, Google Search is available as a tool. This means that the model can decide when to use Google Search. The following example shows how to configure Search as a tool.

from google import genai from google.genai.types import Tool, GenerateContentConfig, GoogleSearch

client = genai.Client() model_id = "gemini-2.0-flash"

google_search_tool = Tool( google_search = GoogleSearch() )

response = client.models.generate_content( model=model_id, contents="When is the next total solar eclipse in the United States?", config=GenerateContentConfig( tools=[google_search_tool], response_modalities=["TEXT"], ) )

for each in response.candidates[0].content.parts: print(each.text) # Example response: # The next total solar eclipse visible in the contiguous United States will be on ...

# To get grounding metadata as web content. print(response.candidates[0].grounding_metadata.search_entry_point.rendered_content)

The Search-as-a-tool functionality also enables multi-turn searches. Combining Search with function calling is not yet supported.

Search as a tool enables complex prompts and workflows that require planning, reasoning, and thinking:

Grounding to enhance factuality and recency and provide more accurate answers Retrieving artifacts from the web to do further analysis on Finding relevant images, videos, or other media to assist in multimodal reasoning or generation tasks Coding, technical troubleshooting, and other specialized tasks Finding region-specific information or assisting in translating content accurately Finding relevant websites for further browsing

Grounding with Google Search works with all available languages when doing text prompts. On the paid tier of the Gemini Developer API, you can get 1,500 Grounding with Google Search queries per day for free, with additional queries billed at the standard $35 per 1,000 queries.

You can learn more by trying the Search tool notebook.

Google Search Suggestions

To use Grounding with Google Search, you have to display Google Search Suggestions, which are suggested queries included in the metadata of the grounded response. To learn more about the display requirements, see Use Google Search Suggestions.

Google Search retrieval Note: Google Search retrieval is only compatible with Gemini 1.5 models. For Gemini 2.0 models, you should use Search as a tool.

To configure a model to use Google Search retrieval, pass in the appropriate tool.

Note that Google Search retrieval is only compatible with the 1.5 models, later models need to use the Search Grounding. If you try to use it, the SDK will convert your code to use the Search Grounding instead and will ignore the dynamic threshold settings.

Getting started

from google import genai from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content( model='gemini-1.5-flash', contents="Who won the US open this year?", config=types.GenerateContentConfig( tools=[types.Tool( google_search=types.GoogleSearchRetrieval )] ) ) print(response)

Dynamic threshold

The dynamic_threshold settings let you control the retrieval behavior, giving you additional control over when Grounding with Google Search is used.

from google import genai from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content( model='gemini-1.5-flash', contents="Who won Roland Garros this year?", config=types.GenerateContentConfig( tools=[types.Tool( google_search_retrieval=types.GoogleSearchRetrieval( dynamic_retrieval_config=types.DynamicRetrievalConfig( mode=types.DynamicRetrievalConfigMode.MODE_DYNAMIC, dynamic_threshold=0.6)) )] ) ) print(response)

Dynamic retrieval Note: Dynamic retrieval is only compatible with Gemini 1.5 Flash. For Gemini 2.0, you should use Search as a tool, as shown above. Some queries are likely to benefit more from Grounding with Google Search than others. The dynamic retrieval feature gives you additional control over when to use Grounding with Google Search.

If the dynamic retrieval mode is unspecified, Grounding with Google Search is always triggered. If the mode is set to dynamic, the model decides when to use grounding based on a threshold that you can configure. The threshold is a floating-point value in the range [0,1] and defaults to 0.3. If the threshold value is 0, the response is always grounded with Google Search; if it's 1, it never is.

How dynamic retrieval works

You can use dynamic retrieval in your request to choose when to turn on Grounding with Google Search. This is useful when the prompt doesn't require an answer grounded in Google Search and the model can provide an answer based on its own knowledge without grounding. This helps you manage latency, quality, and cost more effectively.

Before you invoke the dynamic retrieval configuration in your request, understand the following terminology:

Prediction score: When you request a grounded answer, Gemini assigns a prediction score to the prompt. The prediction score is a floating point value in the range [0,1]. Its value depends on whether the prompt can benefit from grounding the answer with the most up-to-date information from Google Search. Thus, if a prompt requires an answer grounded in the most recent facts on the web, it has a higher prediction score. A prompt for which a model-generated answer is sufficient has a lower prediction score.

Here are examples of some prompts and their prediction scores. Note: The prediction scores are assigned by Gemini and can vary over time depending on several factors.

Prompt Prediction score Comment

"Write a poem about peonies" 0.13 The model can rely on its knowledge and the answer doesn't need grounding.

"Suggest a toy for a 2yo child" 0.36 The model can rely on its knowledge and the answer doesn't need grounding.

"Can you give a recipe for an asian-inspired guacamole?" 0.55 Google Search can give a grounded answer, but grounding isn't strictly required; the model knowledge might be sufficient.

"What's Agent Builder? How is grounding billed in Agent Builder?" 0.72 Requires Google Search to generate a well-grounded answer.

"Who won the latest F1 grand prix?" 0.97 Requires Google Search to generate a well-grounded answer.

Threshold: In your API request, you can specify a dynamic retrieval configuration with a threshold. The threshold is a floating point value in the range [0,1] and defaults to 0.3. If the threshold value is zero, the response is always grounded with Google Search. For all other values of threshold, the following is applicable:

If the prediction score is greater than or equal to the threshold, the answer is grounded with Google Search. A lower threshold implies that more prompts have responses that are generated using Grounding with Google Search. If the prediction score is less than the threshold, the model might still generate the answer, but it isn't grounded with Google Search.

To learn how to set the dynamic retrieval threshold using an SDK or the REST API, see the appropriate code example.

To find a good threshold that suits your business needs, you can create a representative set of queries that you expect to encounter. Then you can sort the queries according to the prediction score in the response and select a good threshold for your use case.

A grounded response

If your prompt successfully grounds to Google Search, the response will include groundingMetadata. A grounded response might look something like this (parts of the response have been omitted for brevity):

{ "candidates": [ { "content": { "parts": [ { "text": "Carlos Alcaraz won the Gentlemen's Singles title at the 2024 Wimbledon Championships. He defeated Novak Djokovic in the final, winning his second consecutive Wimbledon title and fourth Grand Slam title overall. \n" } ], "role": "model" }, ... "groundingMetadata": { "searchEntryPoint": { "renderedContent": "\u003cstyle\u003e\n.container {\n align-items: center;\n border-radius: 8px;\n display: flex;\n font-family: Google Sans, Roboto, sans-serif;\n font-size: 14px;\n line-height: 20px;\n padding: 8px 12px;\n}\n.chip {\n display: inline-block;\n border: solid 1px;\n border-radius: 16px;\n min-width: 14px;\n padding: 5px 16px;\n text-align: center;\n user-select: none;\n margin: 0 8px;\n -webkit-tap-highlight-color: transparent;\n}\n.carousel {\n overflow: auto;\n scrollbar-width: none;\n white-space: nowrap;\n margin-right: -12px;\n}\n.headline {\n display: flex;\n margin-right: 4px;\n}\n.gradient-container {\n position: relative;\n}\n.gradient {\n position: absolute;\n transform: translate(3px, -9px);\n height: 36px;\n width: 9px;\n}\n@media (prefers-color-scheme: light) {\n .container {\n background-color: #fafafa;\n box-shadow: 0 0 0 1px #0000000f;\n }\n .headline-label {\n color: #1f1f1f;\n }\n .chip {\n background-color: #ffffff;\n border-color: #d2d2d2;\n color: #5e5e5e;\n text-decoration: none;\n }\n .chip:hover {\n background-color: #f2f2f2;\n }\n .chip:focus {\n background-color: #f2f2f2;\n }\n .chip:active {\n background-color: #d8d8d8;\n border-color: #b6b6b6;\n }\n .logo-dark {\n display: none;\n }\n .gradient {\n background: linear-gradient(90deg, #fafafa 15%, #fafafa00 100%);\n }\n}\n@media (prefers-color-scheme: dark) {\n .container {\n background-color: #1f1f1f;\n box-shadow: 0 0 0 1px #ffffff26;\n }\n .headline-label {\n color: #fff;\n }\n .chip {\n background-color: #2c2c2c;\n border-color: #3c4043;\n color: #fff;\n text-decoration: none;\n }\n .chip:hover {\n background-color: #353536;\n }\n .chip:focus {\n background-color: #353536;\n }\n .chip:active {\n background-color: #464849;\n border-color: #53575b;\n }\n .logo-light {\n display: none;\n }\n .gradient {\n background: linear-gradient(90deg, #1f1f1f 15%, #1f1f1f00 100%);\n }\n}\n\u003c/style\u003e\n\u003cdiv class=\"container\"\u003e\n \u003cdiv class=\"headline\"\u003e\n \u003csvg class=\"logo-light\" width=\"18\" height=\"18\" viewBox=\"9 9 35 35\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"\u003e\n \u003cpath fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M42.8622 27.0064C42.8622 25.7839 42.7525 24.6084 42.5487 23.4799H26.3109V30.1568H35.5897C35.1821 32.3041 33.9596 34.1222 32.1258 35.3448V39.6864H37.7213C40.9814 36.677 42.8622 32.2571 42.8622 27.0064V27.0064Z\" fill=\"#4285F4\"/\u003e\n \u003cpath fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 43.8555C30.9659 43.8555 34.8687 42.3195 37.7213 39.6863L32.1258 35.3447C30.5898 36.3792 28.6306 37.0061 26.3109 37.0061C21.8282 37.0061 18.0195 33.9811 16.6559 29.906H10.9194V34.3573C13.7563 39.9841 19.5712 43.8555 26.3109 43.8555V43.8555Z\" fill=\"#34A853\"/\u003e\n \u003cpath fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M16.6559 29.8904C16.3111 28.8559 16.1074 27.7588 16.1074 26.6146C16.1074 25.4704 16.3111 24.3733 16.6559 23.3388V18.8875H10.9194C9.74388 21.2072 9.06992 23.8247 9.06992 26.6146C9.06992 29.4045 9.74388 32.022 10.9194 34.3417L15.3864 30.8621L16.6559 29.8904V29.8904Z\" fill=\"#FBBC05\"/\u003e\n \u003cpath fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M26.3109 16.2386C28.85 16.2386 31.107 17.1164 32.9095 18.8091L37.8466 13.8719C34.853 11.082 30.9659 9.3736 26.3109 9.3736C19.5712 9.3736 13.7563 13.245 10.9194 18.8875L16.6559 23.3388C18.0195 19.2636 21.8282 16.2386 26.3109 16.2386V16.2386Z\" fill=\"#EA4335\"/\u003e\n \u003c/svg\u003e\n \u003csvg class=\"logo-dark\" width=\"18\" height=\"18\" viewBox=\"0 0 48 48\" xmlns=\"http://www.w3.org/2000/svg\"\u003e\n \u003ccircle cx=\"24\" cy=\"23\" fill=\"#FFF\" r=\"22\"/\u003e\n \u003cpath d=\"M33.76 34.26c2.75-2.56 4.49-6.37 4.49-11.26 0-.89-.08-1.84-.29-3H24.01v5.99h8.03c-.4 2.02-1.5 3.56-3.07 4.56v.75l3.91 2.97h.88z\" fill=\"#4285F4\"/\u003e\n \u003cpath d=\"M15.58 25.77A8.845 8.845 0 0 0 24 31.86c1.92 0 3.62-.46 4.97-1.31l4.79 3.71C31.14 36.7 27.65 38 24 38c-5.93 0-11.01-3.4-13.45-8.36l.17-1.01 4.06-2.85h.8z\" fill=\"#34A853\"/\u003e\n \u003cpath d=\"M15.59 20.21a8.864 8.864 0 0 0 0 5.58l-5.03 3.86c-.98-2-1.53-4.25-1.53-6.64 0-2.39.55-4.64 1.53-6.64l1-.22 3.81 2.98.22 1.08z\" fill=\"#FBBC05\"/\u003e\n \u003cpath d=\"M24 14.14c2.11 0 4.02.75 5.52 1.98l4.36-4.36C31.22 9.43 27.81 8 24 8c-5.93 0-11.01 3.4-13.45 8.36l5.03 3.85A8.86 8.86 0 0 1 24 14.14z\" fill=\"#EA4335\"/\u003e\n \u003c/svg\u003e\n \u003cdiv class=\"gradient-container\"\u003e\u003cdiv class=\"gradient\"\u003e\u003c/div\u003e\u003c/div\u003e\n \u003c/div\u003e\n \u003cdiv class=\"carousel\"\u003e\n \u003ca class=\"chip\" href=\"https://vertexaisearch.cloud.google.com/grounding-api-redirect/AWhgh4x8Epe-gzpwRBvp7o3RZh2m1ygq1EHktn0OWCtvTXjad4bb1zSuqfJd6OEuZZ9_SXZ_P2SvCpJM7NaFfQfiZs6064MeqXego0vSbV9LlAZoxTdbxWK1hFeqTG6kA13YJf7Fbu1SqBYM0cFM4zo0G_sD9NKYWcOCQMvDLDEJFhjrC9DM_QobBIAMq-gWN95G5tvt6_z6EuPN8QY=\"\u003ewho won wimbledon 2024\u003c/a\u003e\n \u003c/div\u003e\n\u003c/div\u003e\n" }, "groundingChunks": [ { "web": { "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AWhgh4whET1ta3sDETZvcicd8FeNe4z0VuduVsxrT677KQRp2rYghXI0VpfYbIMVI3THcTuMwggRCbFXS_wVvW0UmGzMe9h2fyrkvsnQPJyikJasNIbjJLPX0StM4Bd694-ZVle56MmRA4YiUvwSqad1w6O2opmWnw==", "title": "wikipedia.org" } }, { "web": { "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AWhgh4wR1M-9-yMPUr_KdHlnoAmQ8ZX90DtQ_vDYTjtP2oR5RH4tRP04uqKPLmesvo64BBkPeYLC2EpVDxv9ngO3S1fs2xh-e78fY4m0GAtgNlahUkm_tBm_sih5kFPc7ill9u2uwesNGUkwrQlmP2mfWNU5lMMr23HGktr6t0sV0QYlzQq7odVoBxYWlQ_sqWFH", "title": "wikipedia.org" } }, { "web": { "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AWhgh4wsDmROzbP-tmt8GdwCW_pqISTZ4IRbBuoaMyaHfcQg8WW-yKRQQvMDTPAuLxJh-8_U8_iw_6JKFbQ8M9oVYtaFdWFK4gOtL4RrC9Jyqc5BNpuxp6uLEKgL5-9TggtNvO97PyCfziDFXPsxylwI1HcfQdrz3Jy7ZdOL4XM-S5rC0lF2S3VWW0IEAEtS7WX861meBYVjIuuF_mIr3spYPqWLhbAY2Spj-4_ba8DjRvmevIFUhRuESTKvBfmpxNSM", "title": "cbssports.com" } }, { "web": { "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AWhgh4yzjLkorHiUKjhOPkWaZ9b4cO-cLG-02vlEl6xTBjMUjyhK04qSIclAa7heR41JQ6AAVXmNdS3WDrLOV4Wli-iezyzW8QPQ4vgnmO_egdsuxhcGk3-Fp8-yfqNLvgXFwY5mPo6QRhvplOFv0_x9mAcka18QuAXtj0SPvJfZhUEgYLCtCrucDS5XFc5HmRBcG1tqFdKSE1ihnp8KLdaWMhrUQI21hHS9", "title": "jagranjosh.com" } }, { "web": { "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AWhgh4y9L4oeNGWCatFz63b9PpP3ys-Wi_zwnkUT5ji9lY7gPUJQcsmmE87q88GSdZqzcx5nZG9usot5FYk2yK-FAGvCRE6JsUQJB_W11_kJU2HVV1BTPiZ4SAgm8XDFIxpCZXnXmEx5HUfRqQm_zav7CvS2qjA2x3__qLME6Jy7R5oza1C5_aqjQu422le9CaigThS5bvJoMo-ZGcXdBUCj2CqoXNVjMA==", "title": "apnews.com" } } ], "groundingSupports": [ { "segment": { "endIndex": 85, "text": "Carlos Alcaraz won the Gentlemen's Singles title at the 2024 Wimbledon Championships." }, "groundingChunkIndices": [ 0, 1, 2, 3 ], "confidenceScores": [ 0.97380733, 0.97380733, 0.97380733, 0.97380733 ] }, { "segment": { "startIndex": 86, "endIndex": 210, "text": "He defeated Novak Djokovic in the final, winning his second consecutive Wimbledon title and fourth Grand Slam title overall." }, "groundingChunkIndices": [ 1, 0, 4 ], "confidenceScores": [ 0.96145374, 0.96145374, 0.96145374 ] } ], "webSearchQueries": [ "who won wimbledon 2024" ] } } ], ... }

If the response doesn't include groundingMetadata, this means the response wasn't successfully grounded. There are several reasons this could happen, including low source relevance or incomplete information within the model response.

When a grounded result is generated, the metadata contains URIs that redirect to the publishers of the content that was used to generate the grounded result. These URIs contain the vertexaisearch subdomain, as in this truncated example: https://vertexaisearch.cloud.google.com/grounding-api-redirect/.... The metadata also contains the publishers' domains. The provided URIs remain accessible for 30 days after the grounded result is generated. Important: The provided URIs must be directly accessible by the end users and must not be queried programmatically through automated means. If automated access is detected, the grounded answer generation service might stop providing the redirection URIs. The renderedContent field within searchEntryPoint is the provided code for implementing Google Search Suggestions. See Use Google Search Suggestions to learn more.

se the Live API

This section describes how to use the Live API with one of our SDKs. For more information about the underlying WebSockets API, see the WebSockets API reference.

Send and receive text

import asyncio from google import genai

client = genai.Client(api_key="GEMINI_API_KEY") model = "gemini-2.0-flash-live-001"

config = {"response_modalities": ["TEXT"]}

async def main(): async with client.aio.live.connect(model=model, config=config) as session: while True: message = input("User> ") if message.lower() == "exit": break await session.send_client_content( turns={"role": "user", "parts": [{"text": message}]}, turn_complete=True )

async for response in session.receive(): if response.text is not None: print(response.text, end="")

if __name__ == "__main__": asyncio.run(main())

Receive audio

The following example shows how to receive audio data and write it to a .wav file.

import asyncio import wave from google import genai

client = genai.Client(api_key="GEMINI_API_KEY", http_options={'api_version': 'v1alpha'}) model = "gemini-2.0-flash-live-001"

config = {"response_modalities": ["AUDIO"]}

async def main(): async with client.aio.live.connect(model=model, config=config) as session: wf = wave.open("audio.wav", "wb") wf.setnchannels(1) wf.setsampwidth(2) wf.setframerate(24000)

message = "Hello? Gemini are you there?" await session.send_client_content( turns={"role": "user", "parts": [{"text": message}]}, turn_complete=True )

async for idx,response in async_enumerate(session.receive()): if response.data is not None: wf.writeframes(response.data)

# Un-comment this code to print audio data info # if response.server_content.model_turn is not None: # print(response.server_content.model_turn.parts[0].inline_data.mime_type)

wf.close()

if __name__ == "__main__": asyncio.run(main())

Audio formats

The Live API supports the following audio formats:

Input audio format: Raw 16 bit PCM audio at 16kHz little-endian Output audio format: Raw 16 bit PCM audio at 24kHz little-endian

Stream audio and video

To see an example of how to use the Live API in a streaming audio and video format, run the "Live API - Quickstart" file in the cookbooks repository:

View on GitHub

System instructions

System instructions let you steer the behavior of a model based on your specific needs and use cases. System instructions can be set in the setup configuration and will remain in effect for the entire session.

from google.genai import types

config = { "system_instruction": types.Content( parts=[ types.Part( text="You are a helpful assistant and answer in a friendly tone." ) ] ), "response_modalities": ["TEXT"], }

Incremental content updates

Use incremental updates to send text input, establish session context, or restore session context. For short contexts you can send turn-by-turn interactions to represent the exact sequence of events:

Python

turns = [ {"role": "user", "parts": [{"text": "What is the capital of France?"}]}, {"role": "model", "parts": [{"text": "Paris"}]}, ]

await session.send_client_content(turns=turns, turn_complete=False)

turns = [{"role": "user", "parts": [{"text": "What is the capital of Germany?"}]}]

await session.send_client_content(turns=turns, turn_complete=True)

JSON

{ "clientContent": { "turns": [ { "parts":[ { "text": "" } ], "role":"user" }, { "parts":[ { "text": "" } ], "role":"model" } ], "turnComplete": true } }

For longer contexts it's recommended to provide a single message summary to free up the context window for subsequent interactions.

Change voices

The Live API supports the following voices: Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, and Zephyr.

To specify a voice, set the voice name within the speechConfig object as part of the session configuration:

Python

from google.genai import types

config = types.LiveConnectConfig( response_modalities=["AUDIO"], speech_config=types.SpeechConfig( voice_config=types.VoiceConfig( prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore") ) ) )

JSON

{ "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } } }

Use function calling

You can define tools with the Live API. See the Function calling tutorial to learn more about function calling.

Tools must be defined as part of the session configuration:

config = types.LiveConnectConfig( response_modalities=["TEXT"], tools=[set_light_values] )

async with client.aio.live.connect(model=model, config=config) as session: await session.send_client_content( turns={ "role": "user", "parts": [{"text": "Turn the lights down to a romantic level"}], }, turn_complete=True, )

async for response in session.receive(): print(response.tool_call)

From a single prompt, the model can generate multiple function calls and the code necessary to chain their outputs. This code executes in a sandbox environment, generating subsequent BidiGenerateContentToolCall messages. The execution pauses until the results of each function call are available, which ensures sequential processing.

The client should respond with BidiGenerateContentToolResponse.

Audio inputs and audio outputs negatively impact the model's ability to use function calling.

Handle interruptions

Users can interrupt the model's output at any time. When Voice activity detection (VAD) detects an interruption, the ongoing generation is canceled and discarded. Only the information already sent to the client is retained in the session history. The server then sends a BidiGenerateContentServerContent message to report the interruption.

In addition, the Gemini server discards any pending function calls and sends a BidiGenerateContentServerContent message with the IDs of the canceled calls.

async for response in session.receive(): if response.server_content.interrupted is not None: # The generation was interrupted

Configure voice activity detection (VAD)

By default, the model automatically performs voice activity detection (VAD) on a continuous audio input stream. VAD can be configured with the realtimeInputConfig.automaticActivityDetection field of the setup configuration.

When the audio stream is paused for more than a second (for example, because the user switched off the microphone), an audioStreamEnd event should be sent to flush any cached audio. The client can resume sending audio data at any time.

Alternatively, the automatic VAD can be disabled by setting realtimeInputConfig.automaticActivityDetection.disabled to true in the setup message. In this configuration the client is responsible for detecting user speech and sending activityStart and activityEnd messages at the appropriate times. An audioStreamEnd isn't sent in this configuration. Instead, any interruption of the stream is marked by an activityEnd message.

SDK support for this feature will be available in the coming weeks.

Get the token count

You can find the total number of consumed tokens in the usageMetadata field of the returned server message.

from google.genai import types

async with client.aio.live.connect( model='gemini-2.0-flash-live-001', config=types.LiveConnectConfig( response_modalities=['AUDIO'], ), ) as session: # Session connected while True: await session.send_client_content( turns=types.Content(role='user', parts=[types.Part(text='Hello world!')]) ) async for message in session.receive(): # The server will periodically send messages that include # UsageMetadata. if message.usage_metadata: usage = message.usage_metadata print( f'Used {usage.total_token_count} tokens in total. Response token' ' breakdown:' ) for detail in usage.response_tokens_details: match detail: case types.ModalityTokenCount(modality=modality, token_count=count): print(f'{modality}: {count}')

# For the purposes of this example, placeholder input is continually fed # to the model. In non-sample code, the model inputs would come from # the user. if message.server_content and message.server_content.turn_complete: break

Configure session resumption

To prevent session termination when the server periodically resets the WebSocket connection, configure the sessionResumption field within the setup configuration.

Passing this configuration causes the server to send SessionResumptionUpdate messages, which can be used to resume the session by passing the last resumption token as the SessionResumptionConfig.handle of the subsequent connection.

from google.genai import types

print(f"Connecting to the service with handle {previous_session_handle}...") async with client.aio.live.connect( model="gemini-2.0-flash-live-001", config=types.LiveConnectConfig( response_modalities=["AUDIO"], session_resumption=types.SessionResumptionConfig( # The handle of the session to resume is passed here, # or else None to start a new session. handle=previous_session_handle ), ), ) as session: # Session connected while True: await session.send_client_content( turns=types.Content( role="user", parts=[types.Part(text="Hello world!")] ) ) async for message in session.receive(): # Periodically, the server will send update messages that may # contain a handle for the current state of the session. if message.session_resumption_update: update = message.session_resumption_update if update.resumable and update.new_handle: # The handle should be retained and linked to the session. return update.new_handle

# For the purposes of this example, placeholder input is continually fed # to the model. In non-sample code, the model inputs would come from # the user. if message.server_content and message.server_content.turn_complete: break

Receive a message before the session disconnects

The server sends a GoAway message that signals that the current connection will soon be terminated. This message includes the timeLeft, indicating the remaining time and lets you take further action before the connection will be terminated as ABORTED.

Receive a message when the generation is complete

The server sends a generationComplete message that signals that the model finished generating the response.

Enable context window compression

To enable longer sessions, and avoid abrupt connection termination, you can enable context window compression by setting the contextWindowCompression field as part of the session configuration.

In the ContextWindowCompressionConfig, you can configure a sliding-window mechanism and the number of tokens that triggers compression.

from google.genai import types

config = types.LiveConnectConfig( response_modalities=["AUDIO"], context_window_compression=( # Configures compression with default parameters. types.ContextWindowCompressionConfig( sliding_window=types.SlidingWindow(), ) ), )

Change the media resolution

You can specify the media resolution for the input media by setting the mediaResolution field as part of the session configuration:

from google.genai import types

config = types.LiveConnectConfig( response_modalities=["AUDIO"], media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW, )


Limitations

Consider the following limitations of the Live API and Gemini 2.0 when you plan your project.

Client authentication

The Live API only provides server to server authentication and isn't recommended for direct client use. Client input should be routed through an intermediate application server for secure authentication with the Live API.

Session duration

Session duration can be extended to unlimited by enabling session compression. Without compression, audio-only sessions are limited to 15 minutes, and audio plus video sessions are limited to 2 minutes. Exceeding these limits without compression will terminate the connection.

Context window

A session has a context window limit of 32k tokens.


Context windows

The models available through the Gemini API have context windows that are measured in tokens. The context window defines how much input you can provide and how much output the model can generate. You can determine the size of the context window by calling the getModels endpoint or by looking in the models documentation.

In the following example, you can see that the gemini-1.5-flash model has an input limit of about 1,000,000 tokens and an output limit of about 8,000 tokens, which means a context window is 1,000,000 tokens.

import google.generativeai as genai

model_info = genai.get_model("models/gemini-1.5-flash")

# Returns the "context window" for the model, # which is the combined input and output token limits. print(f"{model_info.input_token_limit=}") print(f"{model_info.output_token_limit=}") # ( input_token_limit=30720, output_token_limit=2048 )count_tokens.py

Count tokens

All input to and output from the Gemini API is tokenized, including text, image files, and other non-text modalities.

You can count tokens in the following ways:

Call count_tokens with the input of the request. This returns the total number of tokens in the input only. You can make this call before sending the input to the model to check the size of your requests. Use the usage_metadata attribute on the response object after calling generate_content. This returns the total number of tokens in both the input and the output: total_token_count. It also returns the token counts of the input and output separately: prompt_token_count (input tokens) and candidates_token_count (output tokens).

Count text tokens

If you call count_tokens with a text-only input, it returns the token count of the text in the input only (total_tokens). You can make this call before calling generate_content to check the size of your requests.

Another option is calling generate_content and then using the usage_metadata attribute on the response object to get the following:

The separate token counts of the input (prompt_token_count) and the output (candidates_token_count) The total number of tokens in both the input and the output (total_token_count)

import google.generativeai as genai

model = genai.GenerativeModel("models/gemini-1.5-flash")

prompt = "The quick brown fox jumps over the lazy dog."

# Call `count_tokens` to get the input token count (`total_tokens`). print("total_tokens: ", model.count_tokens(prompt)) # ( total_tokens: 10 )

response = model.generate_content(prompt)

# On the response for `generate_content`, use `usage_metadata` # to get separate input and output token counts # (`prompt_token_count` and `candidates_token_count`, respectively), # as well as the combined token count (`total_token_count`). print(response.usage_metadata) # ( prompt_token_count: 11, candidates_token_count: 73, total_token_count: 84 )count_tokens.py

Count multi-turn (chat) tokens

If you call count_tokens with the chat history, it returns the total token count of the text from each role in the chat (total_tokens).

Another option is calling send_message and then using the usage_metadata attribute on the response object to get the following:

The separate token counts of the input (prompt_token_count) and the output (candidates_token_count) The total number of tokens in both the input and the output (total_token_count)

To understand how big your next conversational turn will be, you need to append it to the history when you call count_tokens.

import google.generativeai as genai

model = genai.GenerativeModel("models/gemini-1.5-flash")

chat = model.start_chat( history=[ {"role": "user", "parts": "Hi my name is Bob"}, {"role": "model", "parts": "Hi Bob!"}, ] ) # Call `count_tokens` to get the input token count (`total_tokens`). print(model.count_tokens(chat.history)) # ( total_tokens: 10 )

response = chat.send_message( "In one sentence, explain how a computer works to a young child." )

# On the response for `send_message`, use `usage_metadata` # to get separate input and output token counts # (`prompt_token_count` and `candidates_token_count`, respectively), # as well as the combined token count (`total_token_count`). print(response.usage_metadata) # ( prompt_token_count: 25, candidates_token_count: 21, total_token_count: 46 )

from google.generativeai.types.content_types import to_contents

# You can call `count_tokens` on the combined history and content of the next turn. print(model.count_tokens(chat.history + to_contents("What is the meaning of life?"))) # ( total_tokens: 56 )count_tokens.py

Count multimodal tokens

All input to the Gemini API is tokenized, including text, image files, and other non-text modalities. Note the following high-level key points about tokenization of multimodal input during processing by the Gemini API:

With Gemini 2.0, image inputs with both dimensions <=384 pixels are counted as 258 tokens. Images larger in one or both dimensions are cropped and scaled as needed into tiles of 768x768 pixels, each counted as 258 tokens. Prior to Gemini 2.0, images used a fixed 258 tokens. Video and audio files are converted to tokens at the following fixed rates: video at 263 tokens per second and audio at 32 tokens per second.

Image files

If you call count_tokens with a text-and-image input, it returns the combined token count of the text and the image in the input only (total_tokens). You can make this call before calling generate_content to check the size of your requests. You can also optionally call count_tokens on the text and the file separately.

Another option is calling generate_content and then using the usage_metadata attribute on the response object to get the following:

The separate token counts of the input (prompt_token_count) and the output (candidates_token_count) The total number of tokens in both the input and the output (total_token_count)

Note: You'll get the same token count if you use a file uploaded using the File API or you provide the file as inline data. Example that uses an uploaded image from the File API:

import google.generativeai as genai

model = genai.GenerativeModel("models/gemini-1.5-flash")

prompt = "Tell me about this image" your_image_file = genai.upload_file(path=media / "organ.jpg")

# Call `count_tokens` to get the input token count # of the combined text and file (`total_tokens`). # An image's display or file size does not affect its token count. # Optionally, you can call `count_tokens` for the text and file separately. print(model.count_tokens([prompt, your_image_file])) # ( total_tokens: 263 )

response = model.generate_content([prompt, your_image_file]) response.text # On the response for `generate_content`, use `usage_metadata` # to get separate input and output token counts # (`prompt_token_count` and `candidates_token_count`, respectively), # as well as the combined token count (`total_token_count`). print(response.usage_metadata) # ( prompt_token_count: 264, candidates_token_count: 80, total_token_count: 345 )count_tokens.py

Example that provides the image as inline data:

import google.generativeai as genai

import PIL.Image

model = genai.GenerativeModel("models/gemini-1.5-flash")

prompt = "Tell me about this image" your_image_file = PIL.Image.open(media / "organ.jpg")

# Call `count_tokens` to get the input token count # of the combined text and file (`total_tokens`). # An image's display or file size does not affect its token count. # Optionally, you can call `count_tokens` for the text and file separately. print(model.count_tokens([prompt, your_image_file])) # ( total_tokens: 263 )

response = model.generate_content([prompt, your_image_file])

# On the response for `generate_content`, use `usage_metadata` # to get separate input and output token counts # (`prompt_token_count` and `candidates_token_count`, respectively), # as well as the combined token count (`total_token_count`). print(response.usage_metadata) # ( prompt_token_count: 264, candidates_token_count: 80, total_token_count: 345 )count_tokens.py

Video or audio files

Audio and video are each converted to tokens at the following fixed rates:

Video: 263 tokens per second Audio: 32 tokens per second

If you call count_tokens with a text-and-video/audio input, it returns the combined token count of the text and the video/audio file in the input only (total_tokens). You can make this call before calling generate_content to check the size of your requests. You can also optionally call count_tokens on the text and the file separately.

Another option is calling generate_content and then using the usage_metadata attribute on the response object to get the following:

The separate token counts of the input (prompt_token_count) and the output (candidates_token_count) The total number of tokens in both the input and the output (total_token_count)

Note: You'll get the same token count if you use a file uploaded using the File API or you provide the file as inline data. import google.generativeai as genai

import time

model = genai.GenerativeModel("models/gemini-1.5-flash")

prompt = "Tell me about this video" your_file = genai.upload_file(path=media / "Big_Buck_Bunny.mp4")

# Videos need to be processed before you can use them. while your_file.state.name == "PROCESSING": print("processing video...") time.sleep(5) your_file = genai.get_file(your_file.name)

# Call `count_tokens` to get the input token count # of the combined text and video/audio file (`total_tokens`). # A video or audio file is converted to tokens at a fixed rate of tokens per second. # Optionally, you can call `count_tokens` for the text and file separately. print(model.count_tokens([prompt, your_file])) # ( total_tokens: 300 )

response = model.generate_content([prompt, your_file])

# On the response for `generate_content`, use `usage_metadata` # to get separate input and output token counts # (`prompt_token_count` and `candidates_token_count`, respectively), # as well as the combined token count (`total_token_count`). print(response.usage_metadata) # ( prompt_token_count: 301, candidates_token_count: 60, total_token_count: 361 ) count_tokens.py

System instructions and tools

System instructions and tools also count towards the total token count for the input.

If you use system instructions, the total_tokens count increases to reflect the addition of system_instruction.

import google.generativeai as genai

model = genai.GenerativeModel(model_name="gemini-1.5-flash")

prompt = "The quick brown fox jumps over the lazy dog."

print(model.count_tokens(prompt)) # total_tokens: 10

model = genai.GenerativeModel( model_name="gemini-1.5-flash", system_instruction="You are a cat. Your name is Neko." )

# The total token count includes everything sent to the `generate_content` request. # When you use system instructions, the total token count increases. print(model.count_tokens(prompt)) # ( total_tokens: 21 )count_tokens.py

If you use function calling, the total_tokens count increases to reflect the addition of tools.

import google.generativeai as genai

model = genai.GenerativeModel(model_name="gemini-1.5-flash")

prompt = "I have 57 cats, each owns 44 mittens, how many mittens is that in total?"

print(model.count_tokens(prompt)) # ( total_tokens: 22 )

def add(a: float, b: float): """returns a + b.""" return a + b

def subtract(a: float, b: float): """returns a - b.""" return a - b

def multiply(a: float, b: float): """returns a * b.""" return a * b

def divide(a: float, b: float): """returns a / b.""" return a / b

model = genai.GenerativeModel( "models/gemini-1.5-flash-001", tools=[add, subtract, multiply, divide] )

# The total token count includes everything sent to the `generate_content` request. # When you use tools (like function calling), the total token count increases. print(model.count_tokens(prompt)) # ( total_tokens: 206 )count_tokens.py