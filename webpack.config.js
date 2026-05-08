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
const defaultManifest = JSON.parse(fs.readFileSync(manifestPath).toString())

// Update manifest versions from package.json
defaultManifest.version = version

const isDev = process.env.NODE_ENV === 'development'

function getEntryPoints() {
	return {
		options: path.join(srcDir, 'js', 'options.js'),
		popup: path.join(srcDir, 'js', 'popup.js'),
		email_extractor: path.join(srcDir, 'js', 'email-extractor.js'),
		scroll_capture: path.join(srcDir, 'js', 'scroll-capture.js'),
		page_bridge: path.join(srcDir, 'js', 'page-bridge.js'),
		background: path.join(srcDir, 'js', 'background.js'),
	}
}

var common = {
	mode: process.env.NODE_ENV || 'development',
	performance: {
		hints: false, // Extensions load from disk, not network
	},
	entry: getEntryPoints(),
	output: {
		path: destDir,
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
					to: destDir,
					globOptions: {
						ignore: ['**/.DS_Store'],
					},
				},
			],
		}),
		new GenerateJsonPlugin('manifest.json', defaultManifest, null, 2),
		new webpack.DefinePlugin({
			'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
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
