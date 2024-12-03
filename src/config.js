const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function findConfig() {
    const possibleNames = ['config.js', 'dynamo-bao.config.js', '.dynamo-bao/config.js'];
    const searchPaths = [
        process.cwd(),                    // Project root
        path.join(__dirname, '..'),       // Library root
        path.join(__dirname, '../test'),  // Library test directory
    ];
    
    // Search each directory for config files
    for (const searchPath of searchPaths) {
        for (const name of possibleNames) {
            const configPath = path.join(searchPath, name);
            if (fs.existsSync(configPath)) {
                const rawConfig = require(configPath);
                const configDir = path.dirname(configPath);
                
                return {
                    ...rawConfig,
                    paths: {
                        ...rawConfig.paths,
                        modelsDir: rawConfig.paths.modelsDir ? 
                            path.resolve(configDir, rawConfig.paths.modelsDir) : 
                            null
                    }
                };
            }
        }
    }

    // If no config file found, create default config from env
    dotenv.config();
    return {
        aws: {
            region: process.env.AWS_REGION || 'us-west-2',
        },
        db: {
            tableName: process.env.TABLE_NAME || 'dynamo-bao-dev',
        },
        logging: {
            level: process.env.LOG_LEVEL || 'ERROR',
        },
        paths: {
            modelsDir: process.env.MODELS_DIR ? 
                path.resolve(process.cwd(), process.env.MODELS_DIR) : 
                null,
        }
    };
}

// Load config once at module level
const config = findConfig();

module.exports = config;