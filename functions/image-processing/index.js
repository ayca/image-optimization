// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const S3 = new AWS.S3({ signatureVersion: 'v4', httpOptions: { agent: new https.Agent({ keepAlive: true }) } });
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const SECRET_KEY = process.env.secretKey;
const LOG_TIMING = process.env.logTiming;

exports.handler = async (event) => {
    // First validate if the request is coming from CloudFront
    if (!event.headers['x-origin-secret-header'] || !(event.headers['x-origin-secret-header'] === SECRET_KEY)) 
        return sendError(403, 'Request unauthorized', event);
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) 
        return sendError(400, 'Only GET method is supported', event);
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');
    //get if optimized version exists
    try {
        originalImage = await S3.getObject({
            Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
            Key: originalImagePath + '/' + operationsPrefix,
        }).promise();
        contentType = originalImage.ContentType;
        return {
            statusCode: 200,
            body: originalImage.Body.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
            }
        };
    } catch (error) {
        console.log('optimized image not found ' + originalImagePath + '/' + operationsPrefix);
    }
    // timing variable
    var timingLog = "perf ";
    var startTime = performance.now();
    // Downloading original image
    let originalImage;
    let contentType;
    let imgExists = true;
    try {
        originalImage = await S3.getObject({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath }).promise();
        contentType = originalImage.ContentType;
    } catch (error) {
        console.log('error downloading original image ' + originalImagePath);
        // get "image not found" image if product url
        if (originalImagePath.includes('product/')) {
            originalImage = await S3.getObject({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: 'odak-msc/no-img.gif' }).promise();
            contentType = 'image/gif';
            imgExists = false;
        }
        else {
            return sendError(500, 'error downloading original image', error);
        }
    }
    let transformedImage = Sharp(originalImage.Body, { failOn: 'none', animated: false, quality: 100 });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    //  execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    timingLog = timingLog + parseInt(performance.now() - startTime) + ' ';
    startTime = performance.now();
    if (operationsJSON['p']) { //&& operationsJSON['p'] === 'n' && !imgExists
        console.log('original image not found and no placeholder ' + originalImagePath + '/' + operationsPrefix);
        //return sendError(404, 'Not Found', event);
    }
    try {
        if (imgExists) {
            // check if formatting is requested
            if (operationsJSON['format']) {
                var isLossy = false;
                switch (operationsJSON['format']) {
                    case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                    case 'gif': contentType = 'image/gif'; break;
                    case 'webp': contentType = 'image/webp'; isLossy = true; break;
                    case 'png': contentType = 'image/png'; break;
                    case 'avif': contentType = 'image/avif'; isLossy = true; break;
                    default: contentType = 'image/jpeg'; isLossy = true;
                }
                if (operationsJSON['quality'] && isLossy) {
                    transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                        quality: parseInt(operationsJSON['quality']),
                    });
                } else transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                        quality: 100,
                    });
            }
            // check if resizing is requested
            var resizingOptions = {};
            if (operationsJSON['width']) 
                resizingOptions.width = parseInt(operationsJSON['width']);
            if (operationsJSON['height']) 
                resizingOptions.height = parseInt(operationsJSON['height']);
            if (operationsJSON['height'] || operationsJSON['width']) {
                resizingOptions.kernel = 'cubic';
                resizingOptions.quality = 100;
                resizingOptions.fastShrinkOnLoad = true;
            }
            if (resizingOptions) 
                transformedImage = transformedImage.resize(resizingOptions);
            // check if rotation is needed
            if (imageMetadata.orientation) 
                transformedImage = transformedImage.rotate();
            transformedImage = await transformedImage.toBuffer();
        }
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + parseInt(performance.now() - startTime) + ' ';
    startTime = performance.now();
    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET && imgExists) {
        try {
            await S3.putObject({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
            }).promise();
        } catch (error) {
            sendError('APPLICATION ERROR', 'Could not upload transformed image to S3', error);
        }
    }
    timingLog = timingLog + parseInt(performance.now() - startTime) + ' ';
    if (LOG_TIMING === 'true') console.log(timingLog);
    if (imgExists)
        // return transformed image
        return {
            statusCode: 200,
            body: transformedImage.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
            }
        };
    else
        // return transformed image
        return {
            statusCode: 200,
            body: originalImage.Body.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
            }
        };
};

function sendError(statusCode, body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
    return { statusCode, body };
}
