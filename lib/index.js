'use strict'

const async = require('async')
const path = require('path')
const walk = require('walk')
const childProcess = require('child_process')
const urlJoin = require('url-join')

const prepare = require('./prepare')
const comment = require('./comment')

/*
 * Recursively prepare all content roots within the build workspace.
 *
 * opts.revisionID - (optional) If specified, mangle content IDs to submit staging content.
 * opts.contentServiceURL - Content service to submit content to.
 * opts.contentServiceAPIKey - API key valid for the content service.
 */
const recursivelyPrepare = exports.recursivelyPrepare = function (toolbelt, opts, callback) {
  // walk the filesystem from . to find directories that contain a _deconst.json file.
  const options = { followLinks: false }

  let atLeastOne = false
  let allSuccessful = true
  let submittedSomething = false
  const contentIDMap = {}

  const walker = walk.walk(toolbelt.workspacePath(), options)

  walker.on('directories', (root, stats, callback) => {
    toolbelt.debug('Traversing directories: %s', root)

    // Don't traverse into dot or common build directories.
    for (let i = stats.length; i--; i >= 0) {
      var name = stats[i].name
      if (/^\./.test(name) || name === '_build' || name === '_site') {
        stats.splice(i, 1)
      }
    }

    callback()
  })

  walker.on('files', (root, stats, callback) => {
    const hasContent = stats.some((each) => each.name === '_deconst.json')

    if (hasContent) {
      toolbelt.info('Deconst content directory: %s', root)

      opts.contentRoot = root

      prepare.prepare(toolbelt, opts, (err, results) => {
        atLeastOne = true

        if (err) {
          allSuccessful = false
          return callback(err)
        }

        var relativeRoot = path.relative(toolbelt.workspacePath(), root)

        allSuccessful = allSuccessful && results.success
        if (results.didSomething) {
          submittedSomething = true
          contentIDMap[relativeRoot] = results.contentIDBase
        }
        callback(null)
      })
    } else {
      callback(null)
    }
  })

  walker.on('errors', (root, stats, callback) => {
    toolbelt.error('Error walking %s', root, {
      errors: stats.map((e) => e.error)
    })

    callback()
  })

  walker.on('end', () => {
    toolbelt.debug('Walk completed')

    if (!atLeastOne) {
      toolbelt.info('No content discovered to prepare and submit.')
      toolbelt.info('Please add a _deconst.json file to each root directory where content is located.')
    }

    if (!allSuccessful) {
      return callback(new Error('At least one preparer terminated unsuccessfully.'), true)
    }

    callback(null, {
      didSomething: atLeastOne,
      submittedSomething,
      contentIDMap
    })
  })
}

exports.preparePullRequest = function (toolbelt, callback) {
  let revisionID = null
  let transientKey = null
  let contentIDMap = null
  let presentedURLMap = null
  let submittedSomething = false
  let didSomething = false

  const stagingPresenter = toolbelt.stagingPresenter
  const stagingContentService = toolbelt.stagingContentService
  const github = toolbelt.github

  const generateRevisionID = (cb) => {
    // Because this is easier than faking out git rev-parse.
    if (toolbelt.config.mockGitSHA) {
      toolbelt.debug('Returning mocked git workspace SHA.')
      revisionID = `build-${toolbelt.config.mockGitSHA}`

      process.nextTick(() => cb(null))
      return
    }

    toolbelt.debug('Generating revision ID from git SHA of [%s].', toolbelt.workspacePath())

    childProcess.execFile('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: toolbelt.workspacePath() }, (err, stdout, stderr) => {
      if (err) {
        toolbelt.error('unable to execute git.')
        toolbelt.error('[stdout]\n' + stdout.toString())
        toolbelt.error('[stderr]\n' + stderr.toString())

        return cb(err)
      }

      revisionID = 'build-' + stdout.toString().replace(/\r?\n$/, '')
      toolbelt.debug('Revision ID: [%s]', revisionID)
      cb(null)
    })
  }

  const issueTransientKey = (cb) => {
    toolbelt.debug('Issuing transient staging API key.')

    stagingContentService.issueAPIKey('temporary-' + revisionID, function (err, apiKey) {
      if (err) return cb(err)

      transientKey = apiKey
      cb(null)
    })
  }

  const invokePreparer = (cb) => {
    toolbelt.debug('Invoking preparer with revision ID [%s].', revisionID)

    var opts = {
      revisionID: revisionID,
      contentServiceURL: toolbelt.config.stagingContentServiceURL,
      contentServiceAPIKey: transientKey
    }

    recursivelyPrepare(toolbelt, opts, (err, result) => {
      if (err) return cb(err)

      submittedSomething = result.submittedSomething
      didSomething = result.didSomething
      contentIDMap = result.contentIDMap
      cb(null)
    })
  }

  const revokeTransientKey = (cb) => {
    toolbelt.debug('Revoking transient staging API key.')
    stagingContentService.revokeAPIKey(transientKey, cb)
  }

  const getPresentedURLMap = (cb) => {
    if (!stagingPresenter) {
      toolbelt.error('Unable to comment on GitHub: the staging URL is not configured.')
      return cb(null)
    }
    if (!submittedSomething) return cb(null)

    presentedURLMap = {}

    async.forEachOf(contentIDMap, (contentID, contentRoot, cb) => {
      stagingPresenter.whereis(contentID, (err, mappings) => {
        if (err) return cb(err)

        var presentedURLs = mappings.map((mapping) => {
          return urlJoin(toolbelt.config.stagingPresenterURL, mapping.path)
        })

        toolbelt.debug('Content root [%s] is mapped to the URL%s %s.',
          contentRoot, presentedURLs.length === 1 ? 's' : '', presentedURLs)
        presentedURLMap[contentRoot] = presentedURLs

        cb(null)
      })
    }, cb)
  }

  const commentOnGitHub = (cb) => {
    if (!presentedURLMap) return cb(null)
    if (!submittedSomething) return cb(null)

    if (!github) {
      toolbelt.error('Unable to comment on GitHub: no GitHub account available.')

      var contentRoots = Object.keys(presentedURLMap)
      if (contentRoots.length === 1) {
        toolbelt.info('Your preview is available at %s.', presentedURLMap[contentRoots[0]])
      } else {
        toolbelt.info('Your previews are available at:')
        contentRoots.forEach((contentRoot) => {
          toolbelt.info('* %s: %s', contentRoot, presentedURLMap[contentRoot])
        })
      }

      return cb(null)
    }

    const m = /([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(toolbelt.pullRequestURL)

    if (!m) {
      toolbelt.error('Unable to comment on GitHub: the pull request URL looks wrong.')
      toolbelt.error('URL: [%s]', toolbelt.pullRequestURL)

      return cb(null)
    }
    const repoName = m[1]
    const pullRequestNumber = m[2]
    const commentBody = comment.forSuccessfulBuild(presentedURLMap)

    github.postComment(repoName, pullRequestNumber, commentBody, cb)
  }

  async.series([
    generateRevisionID,
    issueTransientKey,
    invokePreparer,
    revokeTransientKey,
    getPresentedURLMap,
    commentOnGitHub
  ], function (err) {
    if (err) return callback(err)

    callback(null, { didSomething: didSomething })
  })
}
