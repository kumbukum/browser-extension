const webpack = require('webpack')
const path = require('path')
const fs = require('fs')
const CopyPlugin = require('copy-webpack-plugin')
const GenerateJsonPlugin = require('generate-json-webpack-plugin')
const { merge } = require('webpack-merge')

const rootDir = path.resolve(__dirname)
const srcDir = path.join(rootDir, 'src')
const destDir = path.join(rootDir, 'build')

// Read version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json')).toString())
const version = packageJson.version

const manifestPath = path.join(srcDir, 'manifest.json')
const firefoxManifestPath = path.join(srcDir, 'manifest.firefox.json')
const defaultManifest = JSON.parse(fs.readFileSync(manifestPath).toString())
const firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath).toString())

// Update manifest versions from package.json
defaultManifest.version = version
firefoxManifest.version = version

const isDev = process.env.NODE_ENV === 'development'
const isFirefox = process.env.BROWSER === 'firefox'

function getManifest() {
	return isFirefox ? firefoxManifest : defaultManifest
}

function getEntryPoints() {
	const baseEntries = {
		options: path.join(srcDir, 'js', 'options.js'),
		popup: path.join(srcDir, 'js', 'popup.js'),
	}

	if (isFirefox) {
		return {
			...baseEntries,
			background: path.join(srcDir, 'js', 'background.firefox.js'),
		}
	} else {
		return {
			...baseEntries,
			background: path.join(srcDir, 'js', 'background.js'),
		}
	}
}

var common = {
	mode: process.env.NODE_ENV || 'development',
	performance: {
		hints: false, // Extensions load from disk, not network
	},
	entry: getEntryPoints(),
	output: {
		path: path.join(rootDir, isFirefox ? 'build-firefox' : 'build'),
		filename: '[name].js',
	},
	module: {
		rules: [
			{
				test: /\.css$/i,
				use: ['style-loader', 'css-loader'],
			},
		],
	},
	resolve: {
		extensions: ['.js'],
	},
	plugins: [
		new CopyPlugin({
			patterns: [
				{
					from: path.join(rootDir, 'public'),
					to: isFirefox ? path.join(rootDir, 'build-firefox') : destDir,
					globOptions: {
						ignore: ['**/.DS_Store'],
					},
				},
			],
		}),
		new GenerateJsonPlugin('manifest.json', getManifest(), null, 2),
		new webpack.DefinePlugin({
			'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
			'process.env.BROWSER': JSON.stringify(process.env.BROWSER || 'chrome'),
		}),
	],
}

function developmentConfig() {
	return merge(common, {
		devtool: 'cheap-module-source-map',
		mode: 'development',
	})
}

function productionConfig() {
	return merge(common, {
		mode: 'production',
	})
}

module.exports = isDev ? developmentConfig() : productionConfig()
