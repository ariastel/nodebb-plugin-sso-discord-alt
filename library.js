'use strict'

const User = require.main.require('./src/user')
const InternalOAuthError = require('passport-oauth').InternalOAuthError
const OAuth2Strategy = require('passport-oauth').OAuth2Strategy
const meta = require.main.require('./src/meta')
const db = require.main.require('./src/database')
const passport = require.main.require('passport')
const nconf = require.main.require('nconf')
const winston = require.main.require('winston')
const async = require.main.require('async')
const authenticationController = require.main.require('./src/controllers/authentication')
const quickFormat = require('quick-format')

const usernameReplacementRegexp = /[^'" \-+.*[\]0-9\u00BF-\u1FFF\u2C00-\uD7FF\w]/ig

function doLog () {
  const args = Array.from(arguments)
  const method = args.splice(0, 1)[0]
  const formatStr = '[sso-discord-alt] ' + args.splice(0, 1)[0]
  method.call(winston, quickFormat([formatStr].concat(args)))
}

function log () {
  doLog.apply(null, [winston.verbose].concat(Array.from(arguments)))
}

function logError () {
  doLog.apply(null, [winston.error].concat(Array.from(arguments)))
}

function logWarn () {
  doLog.apply(null, [winston.warn].concat(Array.from(arguments)))
}

const constants = {
  name: 'discord',
  displayName: 'Discord',
  button: {
    borderColor: '#7289DA',
    backgroundColor: '#7289DA',
    textColor: '#FFF'
  },
  admin: {
    route: '/plugins/sso-discord-alt',
    icon: 'nbb-none'
  },
  oauth: { // a passport-oauth2 options object
    authorizationURL: 'https://discord.com/api/v8/oauth2/authorize',
    tokenURL: 'https://discord.com/api/v8/oauth2/token',
    passReqToCallback: true
  },
  userRoute: 'https://discord.com/api/v8/users/@me'
}

const DiscordAuth = {}

/**
 * Invoked by NodeBB when initializing the plugin.
 *
 * @param {object} data Provides some context information.
 * @param {function} callback Invokec when initialization is complete.
 */
DiscordAuth.init = function (data, callback) {
  log('initializing')

  const hostHelpers = require.main.require('./src/routes/helpers')

  function render (req, res, next) {
    log('rendering admin view')
    res.render('admin/plugins/sso-discord-alt', {})
  }

  data.router.get('/admin/plugins/sso-discord-alt', data.middleware.admin.buildHeader, render)
  data.router.get('/api/admin/plugins/sso-discord-alt', render)

  hostHelpers.setupPageRoute(data.router, `/deauth/${constants.name}`, data.middleware, [data.middleware.requireUser], function (_, res) {
    res.render('plugins/sso-discord-alt/deauth', {
      service: constants.displayName
    })
  })
  data.router.post(`/deauth/${constants.name}`, [data.middleware.requireUser, data.middleware.applyCSRF], function (req, res, next) {
    DiscordAuth.deleteUserData({ uid: req.user.uid }, function (err) {
      if (err) {
        return next(err)
      }

      res.redirect(nconf.get('relative_path') + '/me/edit')
    })
  })

  callback()
}

DiscordAuth.addMenuItem = function (customHeader, callback) {
  log('adding admin menu item')
  customHeader.authentication.push({
    route: constants.admin.route,
    icon: constants.admin.icon,
    name: constants.displayName
  })

  callback(null, customHeader)
}

DiscordAuth.getStrategy = function (strategies, callback) {
  log('adding authentication strategy')
  const options = constants.oauth
  options.callbackURL = nconf.get('url') + '/auth/' + constants.name + '/callback'

  meta.settings.get('sso-discord-alt', function (err, settings) {
    if (err) return callback(err)

    options.clientID = settings.id || process.env.SSO_DISCORD_CLIENT_ID || ''
    options.clientSecret = settings.secret || process.env.SSO_DISCORD_CLIENT_SECRET || ''

    if (!options.clientID || !options.clientSecret) {
      logWarn('Missing sso-discord-alt configuration. Not enabling authentication strategy.')
      return callback(null, strategies)
    }

    function PassportOAuth () {
      OAuth2Strategy.apply(this, arguments)
    }
    require('util').inherits(PassportOAuth, OAuth2Strategy)

    /**
     * Invoked by the OAuth2Strategy prior to the verify callback being invoked.
     *
     * @param {string} accessToken API access token as returned by the remote service.
     * @param {function} done Callback to be invoked when profile parsing is finished.
     */
    PassportOAuth.prototype.userProfile = function (accessToken, done) {
      log('getting user profile from remote service')
      this._oauth2._useAuthorizationHeaderForGET = true
      this._oauth2.get(constants.userRoute, accessToken, function (err, body, res) {
        if (err) return done(new InternalOAuthError('failed to fetch user profile', err))
        try {
          log('parsing remote profile information')
          const oauthUser = JSON.parse(body)
          done(null, { // user profile for verify function
            id: oauthUser.id,
            avatar: oauthUser.avatar ? `https://cdn.discordapp.com/avatars/${oauthUser.id}/${oauthUser.avatar}.png` : null,
            displayName: oauthUser.username,
            email: oauthUser.email,
            provider: constants.name
          })
        } catch (e) {
          done(e)
        }
      })
    }

    const authenticator = new PassportOAuth(options, function verify (req, token, secret, profile, done) {
      log('passport verify function invoked: %j', profile)
      if (req.user && req.user.uid && req.user.uid > 0) {
        User.setUserField(req.user.uid, constants.name + 'Id', profile.id)
        db.setObjectField(constants.name + 'Id:uid', profile.id, req.user.uid)

        return authenticationController.onSuccessfulLogin(req, req.user.uid, function (err) {
          done(err, !err ? req.user : null)
        })
      }

      DiscordAuth.login(profile, function (err, user) {
        if (err) return done(err)
        authenticationController.onSuccessfulLogin(req, user.uid, function (err) {
          done(err, !err ? user : null)
        })
      })
    })
    passport.use(constants.name, authenticator)

    strategies.push({
      name: constants.name,
      url: '/auth/' + constants.name,
      callbackURL: `/auth/${constants.name}/callback`,
      icon: constants.admin.icon,
      scope: ['identify', 'email'],

      displayName: constants.displayName,
      ...constants.button
    })
    log('authentication strategy added')

    callback(null, strategies)
  })
}

DiscordAuth.getAssociation = function (data, callback) {
  log('determining if user is associated with discord')
  User.getUserField(data.uid, constants.name + 'Id', function (err, discordId) {
    if (err) return callback(err, data)

    if (discordId) {
      log('user is associated with discord')
      data.associations.push({
        associated: true,
        url: `https://discordapp.com/users/${discordId}`,
        deauthUrl: `${nconf.get('url')}/deauth/${constants.name}`,
        name: constants.displayName,
        icon: constants.admin.icon
      })
    } else {
      log('user is not asscociated with discord')
      data.associations.push({
        associated: false,
        url: `${nconf.get('url')}/auth/${constants.name}`,
        name: constants.displayName,
        icon: constants.admin.icon
      })
    }

    callback(null, data)
  })
}

DiscordAuth.login = function (profile, callback) {
  log('login invoked: %j', profile)
  DiscordAuth.getUidByOAuthid(profile.id, function (err, uid) {
    if (err) {
      logError('could not determine uid from OAuthId: %s', profile.id)
      return callback(err)
    }

    // Existing User
    if (uid !== null) {
      log('user already exists: %s', uid)
      return callback(null, { uid })
    }

    // New User
    log('determing if new user: %s', uid)
    const success = function (uid) {
      log('updating user record with remote service data: (%s, %s)', profile.id, uid)
      // Save provider-specific information to the user
      User.setUserField(uid, constants.name + 'Id', profile.id)
      db.setObjectField(constants.name + 'Id:uid', profile.id, uid)

      if (profile.avatar) {
        User.setUserField(uid, 'uploadedpicture', profile.avatar)
        User.setUserField(uid, 'picture', profile.avatar)
      }

      callback(null, { uid })
    }

    User.getUidByEmail(profile.email, function (err, uid) {
      if (err) {
        logError('could not lookup user by email %s: %s', profile.email, err.message)
        return callback(err)
      }
      if (uid) {
        log('user with email address already exists, merging: %s', profile.email)
        // TODO: this seems easily exploitable
        return success(uid)
      }

      log('creating new user: %s', uid)
      const userFields = {
        username: profile.displayName.replace(usernameReplacementRegexp, ''),
        fullname: profile.displayName,
        email: profile.email
      }
      User.create(userFields, function (err, uid) {
        if (err) {
          logError('could not create user %s: %s', uid, err.message)
          return callback(err)
        }
        log('user created')
        success(uid)
      })
    })
  })
}

DiscordAuth.getUidByOAuthid = function (oAuthid, callback) {
  db.getObjectField(constants.name + 'Id:uid', oAuthid, function (err, uid) {
    if (err) {
      logError('could not get object field from database %s: %s', oAuthid, err.message)
      return callback(err)
    }
    callback(null, uid)
  })
}

DiscordAuth.deleteUserData = function (idObj, callback) {
  log('deleteUserData invoked: %j', idObj)
  const operations = [
    async.apply(User.getUserField, idObj.uid, constants.name + 'Id'),
    function (oAuthIdToDelete, next) {
      log('deleting oAuthId: %s', oAuthIdToDelete)
      db.deleteObjectField(constants.name + 'Id:uid', oAuthIdToDelete, next)
    },
    function (next) {
      db.deleteObjectField('user:' + idObj.uid, constants.name + 'Id', next)
    }
  ]
  async.waterfall(operations, function (err) {
    if (err) {
      logError('Could not remove OAuthId data for uid %j. Error: %s', idObj.uid, err.message)
      return callback(err)
    }
    log('finished deleting user: %s', idObj.uid)
    callback(null, idObj.uid)
  })
}

module.exports = DiscordAuth
