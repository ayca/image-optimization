// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
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
        const getCommand = new GetObjectCommand({ Bucket: S3_TRANSFORMED_IMAGE_BUCKET, Key: originalImagePath + '/' + operationsPrefix });
        const getCommandOutput = await s3Client.send(getCommand);
        console.log(`Got response from S3 for ${originalImagePath}`);

        originalImageBody = getCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
        
        return {
            statusCode: 200,
            body: originalImageBody.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
            }
        };
    } catch (error) {
        console.log('optimized image not found ' + originalImagePath + '/' + operationsPrefix);
    }
    
    var startTime = performance.now();
    // Downloading original image
    let originalImageBody;
    let contentType;
    let imgExists = true;
    try {
        const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath });
        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        console.log(`Got response from S3 for ${originalImagePath}`);

        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
    } catch (error) {
        console.log('error downloading original image ' + originalImagePath);
        // get "image not found" image if product url
        if (originalImagePath.includes('product/')) {
	        const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: 'odak-msc/no-img.gif' });
	        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
	        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
            contentType = 'image/gif';
            imgExists = false;
        }
        else {
            return sendError(500, 'error downloading original image', error);
        }
    }
    let transformedImage = Sharp(await originalImageBody, { failOn: 'none', animated: true, quality: 100 });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    //  execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // variable holding the server timing header value
    var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    if (operationsJSON['p'] && operationsJSON['p'] === 'n' && !imgExists) {
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
    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture

    startTime = performance.now();
    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET && imgExists) {
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
            })
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
    }
    
    if (imgExists)
        // return transformed image
        return {
            statusCode: 200,
            body: transformedImage.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            	'Server-Timing': timingLog
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
    logError(body, error);
    return { statusCode, body };
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
}
