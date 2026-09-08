/**
 * config.js — All IBM watsonx / Granite credentials come from environment variables.
 *
 * For local development, create a .env file (see .env.example) and ensure
 * dotenv is loaded before this module is imported (done in server.js).
 *
 * For IBM Cloud Code Engine, set these as environment variables / secrets in
 * the Code Engine project — do NOT commit .env to source control.
 */

module.exports = {
  IBM_API_KEY:    process.env.IBM_API_KEY    || '',
  IBM_URL:        process.env.IBM_URL        || 'https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29',
  IBM_MODEL_ID:   process.env.IBM_MODEL_ID   || 'ibm/granite-4-h-small',
  IBM_PROJECT_ID: process.env.IBM_PROJECT_ID || '',
};
