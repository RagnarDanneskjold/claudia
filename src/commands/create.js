/*global module, require, console */
var Promise = require('bluebird'),
	path = require('path'),
	shell = require('shelljs'),
	aws = require('aws-sdk'),
	zipdir = require('../tasks/zipdir'),
	collectFiles = require('../tasks/collect-files'),
	addPolicy = require('../tasks/add-policy'),
	markAlias = require('../tasks/mark-alias'),
	templateFile = require('../util/template-file'),
	validatePackage = require('../tasks/validate-package'),
	retriableWrap = require('../util/retriable-wrap'),
	rebuildWebApi = require('../tasks/rebuild-web-api'),
	readjson = require('../util/readjson'),
	apiGWUrl = require('../util/apigw-url'),
	promiseWrap = require('../util/promise-wrap'),
	retry = require('oh-no-i-insist'),
	fs = Promise.promisifyAll(require('fs')),
	os = require('os'),
	NullLogger = require('../util/null-logger');
module.exports = function create(options, optionalLogger) {
	'use strict';
	var logger = optionalLogger || new NullLogger(),
		source = (options && options.source) || shell.pwd(),
		configFile = (options && options.config) || path.join(source, 'claudia.json'),
		iam = promiseWrap(new aws.IAM(), {log: logger.logApiCall, logName: 'iam'}),
		lambda = promiseWrap(new aws.Lambda({region: options.region}), {log: logger.logApiCall, logName: 'lambda'}),
		roleMetadata,
		policyFiles = function () {
			var files = shell.ls('-R', options.policies);
			if (shell.test('-d', options.policies)) {
				files = files.map(function (filePath) {
					return path.join(options.policies, filePath);
				});
			}
			return files.filter(function (filePath) {
				return shell.test('-f', filePath);
			});
		},
		validationError = function () {
			if (source === os.tmpdir()) {
				return 'Source directory is the Node temp directory. Cowardly refusing to fill up disk with recursive copy.';
			}
			if (!options.region) {
				return 'AWS region is missing. please specify with --region';
			}
			if (!options.handler && !options['api-module']) {
				return 'Lambda handler is missing. please specify with --handler';
			}
			if (options.handler && options.handler.indexOf('/') >= 0) {
				return 'Lambda handler module has to be in the main project directory';
			}
			if (options['api-module'] && options['api-module'].indexOf('/') >= 0) {
				return 'API module has to be in the main project directory';
			}
			if (shell.test('-e', configFile)) {
				if (options && options.config) {
					return options.config + ' already exists';
				}
				return 'claudia.json already exists in the source folder';
			}
			if (!shell.test('-e', path.join(source, 'package.json'))) {
				return 'package.json does not exist in the source folder';
			}
			if (options.policies && !policyFiles().length) {
				return 'no files match additional policies (' + options.policies + ')';
			}
			if (options.memory || options.memory === 0) {
				if (options.memory < 128) {
					return 'the memory value provided must be greater than or equal to 128';
				}
				if (options.memory > 1536) {
					return 'the memory value provided must be less than or equal to 1536';
				}
				if (options.memory % 64 !== 0) {
					return 'the memory value provided must be a multiple of 64';
				}
			}
			if (options.timeout || options.timeout === 0) {
				if (options.timeout < 1) {
					return 'the timeout value provided must be greater than or equal to 1';
				}
				if (options.timeout > 300) {
					return 'the timeout value provided must be less than or equal to 300';
				}
			}
		},
		getPackageInfo = function () {
			logger.logStage('loading package config');
			return readjson(path.join(source, 'package.json')).then(function (jsonConfig) {
				var name = options.name || (jsonConfig.name && jsonConfig.name.trim()),
					description = options.description || (jsonConfig.description && jsonConfig.description.trim());
				if (!name) {
					return Promise.reject('project name is missing. please specify with --name or in package.json');
				}
				return {
					name: name,
					description: description
				};
			});
		},
		createLambda = function (functionName, functionDesc, zipFile, roleArn) {
			return retry(
				function () {
					logger.logStage('creating Lambda');
					return lambda.createFunctionPromise({
						Code: { ZipFile: zipFile },
						FunctionName: functionName,
						Description: functionDesc,
						MemorySize: options.memory,
						Timeout: options.timeout,
						Handler: options.handler || (options['api-module'] + '.router'),
						Role: roleArn,
						Runtime: options.runtime || 'nodejs4.3',
						Publish: true
					});
				},
				3000, 10,
				function (error) {
					return error && error.cause && error.cause.message == 'The role defined for the function cannot be assumed by Lambda.';
				},
				function () {
					logger.logStage('waiting for IAM role propagation');
				},
				Promise
			);
		},
		markAliases = function (lambdaData) {
			logger.logStage('creating version alias');
			return markAlias(lambdaData.FunctionName, lambda, '$LATEST', 'latest')
			.then(function () {
				if (options.version) {
					return markAlias(lambdaData.FunctionName, lambda, lambdaData.Version, options.version);
				}
			}).then(function () {
				return lambdaData;
			});
		},
		createWebApi = function (lambdaMetadata, packageDir) {
			var apiModule, apiConfig, apiModulePath,
				alias = options.version || 'latest',
				apiGateway = retriableWrap(promiseWrap(
									new aws.APIGateway({region: options.region}),
									{log: logger.logApiCall, logName: 'apigateway'}
								),
								function () {
									logger.logStage('rate-limited by AWS, waiting before retry');
								}
							);
			logger.logStage('creating REST API');
			try {
				apiModulePath = path.join(packageDir, options['api-module']);
				apiModule = require(path.resolve(apiModulePath));
				apiConfig = apiModule && apiModule.apiConfig && apiModule.apiConfig();
			}
			catch (e) {
				console.error(e.stack || e);
				return Promise.reject('cannot load api config from ' + apiModulePath);
			}

			if (!apiConfig) {
				return Promise.reject('No apiConfig defined on module \'' + options['api-module'] + '\'. Are you missing a module.exports?');
			}
			return apiGateway.createRestApiPromise({
				name: lambdaMetadata.FunctionName
			}).then(function (result) {

				lambdaMetadata.api = {
					id: result.id,
					module: options['api-module'],
					url: apiGWUrl(result.id, options.region, alias)
				};
				return rebuildWebApi(lambdaMetadata.FunctionName, alias, result.id, apiConfig, options.region, logger);
			}).then(function () {
				if (apiModule.postDeploy) {
					return apiModule.postDeploy(
						options,
						{
							name: lambdaMetadata.FunctionName,
							alias: alias,
							apiId: lambdaMetadata.api.id,
							apiUrl: lambdaMetadata.api.url,
							region: options.region
						},
						{
							apiGatewayPromise: apiGateway,
							aws: aws,
							Promise: Promise
						}
					);
				}
			}).then(function (postDeployResult) {
				if (postDeployResult) {
					lambdaMetadata.api.deploy = postDeployResult;
				}
				return lambdaMetadata;
			});
		},
		saveConfig = function (lambdaMetaData) {
			var config = {
				lambda: {
					role: roleMetadata.Role.RoleName,
					name: lambdaMetaData.FunctionName,
					region: options.region
				}
			};
			logger.logStage('saving configuration');
			if (lambdaMetaData.api) {
				config.api =  { id: lambdaMetaData.api.id, module: lambdaMetaData.api.module };
			}
			return fs.writeFileAsync(
				configFile,
				JSON.stringify(config, null, 2),
				'utf8'
			).then(function () {
				return lambdaMetaData;
			});
		},
		formatResult = function (lambdaMetaData) {
			var config = {
				lambda: {
					role: roleMetadata.Role.RoleName,
					name: lambdaMetaData.FunctionName,
					region: options.region
				}
			};
			if (lambdaMetaData.api) {
				config.api =  lambdaMetaData.api;
			}
			return config;
		},
		loadRole = function (functionName) {
			logger.logStage('initialising IAM role');
			if (options.role) {
				return iam.getRolePromise({RoleName: options.role});
			} else {
				return fs.readFileAsync(templateFile('lambda-exector-policy.json'), 'utf8')
					.then(function (lambdaRolePolicy) {
						return iam.createRolePromise({
							RoleName: functionName + '-executor',
							AssumeRolePolicyDocument: lambdaRolePolicy
						});
					});
			}
		},
		addExtraPolicies = function () {
			return Promise.map(policyFiles(), function (fileName) {
				var policyName = path.basename(fileName).replace(/[^A-z0-9]/g, '-');
				return addPolicy(policyName, roleMetadata.Role.RoleName, fileName);
			});
		},
		recursivePolicy = function (functionName) {
			return JSON.stringify({
				'Version': '2012-10-17',
				'Statement': [{
					'Sid': 'InvokePermission',
					'Effect': 'Allow',
					'Action': [
						'lambda:InvokeFunction'
					],
					'Resource': 'arn:aws:lambda:' + options.region + ':*:function:' + functionName
				}]
			});
		},
		packageArchive,
		functionDesc,
		functionName,
		packageFileDir;
	if (validationError()) {
		return Promise.reject(validationError());
	}
	return getPackageInfo().then(function (packageInfo) {
		functionName = packageInfo.name;
		functionDesc = packageInfo.description;
	}).then(function () {
		return collectFiles(source, options['use-local-dependencies'], logger);
	}).then(function (dir) {
		logger.logStage('validating package');
		return validatePackage(dir, options.handler, options['api-module']);
	}).then(function (dir) {
		packageFileDir = dir;
		logger.logStage('zipping package');
		return zipdir(dir);
	}).then(function (zipFile) {
		packageArchive = zipFile;
	}).then(function () {
		return loadRole(functionName);
	}).then(function (result) {
		roleMetadata = result;
	}).then(function () {
		return addPolicy('log-writer', roleMetadata.Role.RoleName);
	}).then(function () {
		if (options.policies) {
			return addExtraPolicies();
		}
	}).then(function () {
		if (options['allow-recursion']) {
			return iam.putRolePolicyPromise({
				RoleName:  roleMetadata.Role.RoleName,
				PolicyName: 'recursive-execution',
				PolicyDocument: recursivePolicy(functionName)
			});
		}
	}).then(function () {
		return fs.readFileAsync(packageArchive);
	}).then(function (fileContents) {
		return createLambda(functionName, functionDesc, fileContents, roleMetadata.Role.Arn);
	}).then(markAliases)
	.then(function (lambdaMetadata) {
		if (options['api-module']) {
			return createWebApi(lambdaMetadata, packageFileDir);
		} else {
			return lambdaMetadata;
		}
	})
	.then(saveConfig).then(formatResult);
};

module.exports.doc = {
	description: 'Create the initial lambda function and related security role.',
	priority: 1,
	args: [
		{
			argument: 'region',
			description: 'AWS region where to create the lambda',
			example: 'us-east-1'
		},
		{
			argument: 'handler',
			optional: true,
			description: 'Main function for Lambda to execute, as module.function',
			example: 'if it is in the main.js file and exported as router, this would be main.router'
		},
		{
			argument: 'api-module',
			optional: true,
			description: 'The main module to use when creating Web APIs. \n' +
				'If you provide this parameter, the handler option is ignored.\n' +
				'This should be a module created using the Claudia API Builder.',
			example: 'if the api is defined in web.js, this would be web'
		},
		{
			argument: 'name',
			optional: true,
			description: 'lambda function name',
			example: 'awesome-microservice',
			'default': 'the project name from package.json'
		},
		{
			argument: 'version',
			optional: true,
			description: 'A version alias to automatically assign to the new function',
			example: 'development'
		},
		{
			argument: 'source',
			optional: true,
			description: 'Directory with project files',
			'default': 'current directory'
		},
		{
			argument: 'config',
			optional: true,
			description: 'Config file where the creation result will be saved',
			'default': 'claudia.json'
		},
		{
			argument: 'policies',
			optional: true,
			description: 'A directory or file pattern for additional IAM policies\n' +
				'which will automatically be included into the security role for the function',
			example: 'policies/*.xml'
		},
		{
			argument: 'allow-recursion',
			optional: true,
			description: 'Set up IAM permissions so a function can call itself recursively'
		},
		{
			argument: 'role',
			optional: true,
			description: 'The name of an existing role to assign to the function. \n' +
				'If not supplied, Claudia will create a new role'
		},
		{
			argument: 'runtime',
			optional: true,
			description: 'Node.js runtime to use. For supported values, see\n http://docs.aws.amazon.com/lambda/latest/dg/API_CreateFunction.html',
			default: 'node4.3'
		},
		{
			argument: 'description',
			optional: true,
			description: 'Textual description of the lambda function',
			default: 'the project description from package.json'
		},
		{
			argument: 'memory',
			optional: true,
			description: 'The amount of memory, in MB, your Lambda function is given.\nThe value must be a multiple of 64 MB.',
			default: 128
		},
		{
			argument: 'timeout',
			optional: true,
			description: 'The function execution time, in seconds, at which AWS Lambda should terminate the function',
			default: 3
		},
		{
			argument: 'use-local-dependencies',
			optional: true,
			description: 'Do not install dependencies, use local node_modules directory instead'
		}
	]
};
