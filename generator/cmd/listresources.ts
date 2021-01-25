import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import * as constants from '../constants';
import { lowerCaseCompare, executeSynchronous } from '../utils';

interface ListResourcesParams {
    outputFile?: string,
}

function parseParams(): ListResourcesParams {
    return {
        outputFile: process.argv[2],
    };
}

const rootSchemaPaths = [
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json',
    'https://schema.management.azure.com/schemas/common/definitions.json',
    'https://schema.management.azure.com/schemas/common/autogeneratedResources.json',
    'https://schema.management.azure.com/schemas/common/manuallyAddedResources.json',
    'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json',
    'https://schema.management.azure.com/schemas/2019-08-01/tenantDeploymentTemplate.json',
    'https://schema.management.azure.com/schemas/2019-08-01/managementGroupDeploymentTemplate.json',
];

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

async function readSchema(schemaUri: string) {
    if (!schemaUri.toLowerCase().startsWith(constants.schemasBaseUri.toLowerCase() + '/')) {
        throw new Error(`Invalid schema Uri ${schemaUri}`);
    }

    try {
        const filePath = path.resolve(path.join(constants.schemasBasePath, schemaUri.substring(constants.schemasBaseUri.length + 1)));
        const fileContents = await readFile(filePath, { encoding: 'utf8'});
    
        return JSON.parse(fileContents);
    } catch (e) {
        throw new Error(`Caught error processing ${schemaUri}: ${e}`);
    }
}

function findAllReferences(input: any) {
    let refs: any[] = [];

    for (const key of Object.keys(input)) {
        if (Array.isArray(input[key])) {
            for (const value of input[key]) {
                const foundRefs = findAllReferences(value);
                refs = refs.concat(foundRefs);
            }
        } else if (typeof input[key] === 'object') {
            const foundRefs = findAllReferences(input[key]);
            refs = refs.concat(foundRefs);
        } else if (key === '$ref' && typeof input[key] === 'string') {
            refs.push(input[key]);
        }
    }

    return refs;
}

async function getResourceInfo(schemaRef: string) {
    const schemaUri = schemaRef.split('#')[0];
    const relativeRef = schemaRef.split('#')[1].substring(1);

    let schema = await readSchema(schemaUri);

    for (const pathElement of relativeRef.split('/')) {
        schema = schema[pathElement];
    }

    if (!schema?.properties?.type?.enum || !schema?.properties?.apiVersion?.enum) {
        throw new Error(`Unable to find expected properties for ${schemaRef}`)
    }
    
    const resourceTypes: string[] = schema['properties']['type']['enum'];
    const apiVersions: string[] = schema['properties']['apiVersion']['enum'];

    return resourceTypes.map(type => apiVersions.map(apiVersion => ({
        apiVersion,
        type,
    }))).reduce((a, b) => a.concat(b), []);
}

async function findAllResourceReferences() {
    let allRefs: any[] = [];
    for (const rootSchemaPath of rootSchemaPaths) {
        const rootSchema = await readSchema(rootSchemaPath);
        const schemaRefs = findAllReferences(rootSchema)
            .filter(schema => schema.toLowerCase().startsWith(constants.schemasBaseUri.toLowerCase() + '/'));

        allRefs = allRefs.concat(schemaRefs);        
    }

    for (const rootSchemaPath of rootSchemaPaths) {
        allRefs = allRefs.filter(ref => lowerCaseCompare(ref.split('#')[0], rootSchemaPath) !== 0);
    }

    return [...new Set(allRefs)];
}

executeSynchronous(async () => {
    const params = parseParams();
    const rootSchemaRefs = await findAllResourceReferences();

    const allResources: {[type: string]: string[]} = {};
    for (const ref of rootSchemaRefs) {
        const resources = await getResourceInfo(ref);
        
        for (const resource of resources) {
            // Casing can vary, so do a case-insensitive lookup
            let resourceKey = Object.keys(allResources).find(key => lowerCaseCompare(key, resource.type) === 0);
            if (resourceKey === undefined) {
                resourceKey = resource.type;
                allResources[resourceKey] = [];
            }
    
            allResources[resourceKey].push(resource.apiVersion);
        }
    }

    for (const resourceType of Object.keys(allResources)) {
        allResources[resourceType].sort();
    }

    const sortedJsonOutput = JSON.stringify(allResources, Object.keys(allResources).sort(), 2);
    if (params.outputFile) {
        await writeFile(params.outputFile, sortedJsonOutput, { encoding: 'utf8' });
    } else {
        console.log(sortedJsonOutput);
    }
});