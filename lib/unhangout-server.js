var logger = require('./logging').getLogger(),
	_ = require('underscore')._,
	EventEmitter = require('events').EventEmitter,
    UnhangoutDb = require('./unhangout-db'),
    UnhangoutSocketManager = require('./unhangout-sockets').UnhangoutSocketManager,
    //UnhangoutSocketManager = require('./unhangout-rooms').UnhangoutSocketManager,
    unhangoutRoutes = require('./unhangout-routes'),
    permalinkRoutes = require('./permalink-routes'),
    models = require('./server-models.js'),
    utils = require('./utils'),
	farming = require('./hangout-farming.js'),
	async = require('async'),
	express = require('express'),
	RedisStore = require('connect-redis')(express),
	http = require('http'),
	https = require('https'),
	passport = require('passport'),
	GoogleStrategy = require('passport-google-oauth').OAuth2Strategy,
    stylus = require('stylus'),
    nib = require('nib'),
	fs = require('fs');

// This is the primary class that represents the UnhangoutServer.
// I organize the server pieces into a class so we can more easily
// manage the lifecycle of the server in an object-oriented way.
// In particular, this makes testing much more tractable.
// The server has four main lifecycle methods:
//
//	1. init()		prepare the server for starting - connect to DB, load models, etc. does not bind to any ports or start handling requests
//	2. start()		start the http + sockjs serving cores
//	3. stop()		shut down the externally facing connections, close all existing client connections, etc. in theory, you should be able to call start() after stop() but I haven't tested that lately.
//	4. destroy()	dereference all the major class variables
//
// Each of these lifecycle methods emits an event when it completes, eg 'inited', 'started', 'stopped', 'destroyed'
//
//

// the constructor does basically nothing, since all substantive setup
// takes place in init() instead.
exports.UnhangoutServer = function() {

}

exports.UnhangoutServer.prototype = {
	options: null,			// passed in to init(), configuration options
	running: false,			// true if server is started
	inited: false,			// flag to check initialization state
	
	express: null,			// reference to the http express wrapper
	http: null,				// reference to the node http server base object
	
	init: function(options) {
		if(_.isUndefined(options)) {
			options = {};
		}
		
		// apply default options if they're not provided.
		// (otherwise, they will come from conf.json)
		this.options = _.defaults(options, {"HOST":"localhost", "PORT":7777,
			"REDIS_HOST":"localhost", "REDIS_PORT":6379, "SESSION_SECRET":"fake secret", "REDIS_DB":0, "persist":true,
			"timeoutHttp":false});

		if(!("GOOGLE_CLIENT_ID" in this.options)) {
			logger.error("Missing GOOGLE_CLIENT_ID in options.")
			this.emit("error", "Missing GOOGLE_CLIENT_ID in options.");
			return;
		}
		
		if(!("GOOGLE_CLIENT_SECRET" in this.options)) {
			logger.error("Missing GOOGLE_CLIENT_SECRET in options.")
			this.emit("error", "Missing GOOGLE_CLIENT_SECRET in options.");
			return;
		}
		
		// TODO is it bad for this to be the same as the session secret? leaving the same for now.
		models.USER_KEY_SALT = this.options.SESSION_SECRET;
		
        this.db = new UnhangoutDb(options);
        this.db.init(_.bind(function(err) {
            if (!err) {
                this.inited = true;
                this.emit("inited");
            }
        }, this));
		
	},
	
	start: function() {
		if(!this.inited) {
			logger.error("Attempted to start, but server is not initialized.");
			this.emit("error", "Attempted to start, but server is not initialized.");
			return;
		}
				
		logger.log("info", "Starting UnhangoutServer on %s:%d", this.options.HOST, this.options.PORT);
		
		this.express = express();
        this.express.locals = {
            _: _,
            event: undefined,
            user: undefined
        }

		if(this.options.USE_SSL) {
			try {
				var privateKey = fs.readFileSync(this.options.PRIVATE_KEY).toString();
	    		var cert = fs.readFileSync(this.options.CERTIFICATE).toString();				
			} catch (e) {
				logger.error(e);
				logger.error("Error loading private key or certificate. Ensure that keys are present at the paths specified in conf.json:PRIVATE_KEY/CERTIFICATE");
				logger.error("Shutting down server; can't start without keys present if USE_SSL is true.");
				return;
			}

			this.http = https.createServer({key:privateKey, cert:cert}, this.express);
			logger.log("info", "Created HTTPS server");
		} else {
			this.http = http.createServer(this.express);
			logger.log("info", "Created HTTP server");
		}
        if(this.options.REDIRECT_HTTP) {
            this.httpRedirect = require("./redirect-https")();
        }

        this.socketManager = new UnhangoutSocketManager(this.http, this.db, this.options);
        this.socketManager.init();
		
		// passport is a library we use for doing google authentication. it
		// abstracts the process of redirecting people to google and dealing
		// with the tokens we get in response.
		//
		// this part deals with creating new user objects.
		passport.use(new GoogleStrategy({
			clientID: this.options.GOOGLE_CLIENT_ID,
			clientSecret: this.options.GOOGLE_CLIENT_SECRET,
			callbackURL: "//" + this.options.HOST + ":" + this.options.PORT + "/auth/google/callback"
		}, _.bind(function(accessToken, refreshToken, profile, done) {

			// Add this newly callback-ed user to our list of known users.
			delete profile["_raw"];

			logger.debug("users.length" + this.db.users.length);
			
			// Minor note: this whole block assumes that a user can't possibly exist
			// in the database. There is, actually, a case where they WILL exist.
			// When a user joins a permalink hangout, we get some limited information
			// about them and store it as a user object. User objects created that way 
			// will have a lot less information about them, since we didn't get full
			// permissions from that user to access their google plus account.
			var newUser = new models.ServerUser(profile);

			var oldUser = this.db.users.get(newUser.id);
			if(!_.isUndefined(oldUser)) {
				logger.warn("Found an existing user with id " + newUser.id + " in our user list. It will be replaced. Old user attributes: " + oldUser.attributes);
			}
			// we're not really going to do anything special here, except note it in the logs.
			this.db.users.remove(oldUser);

			// a google plus profile can have more than one email. check
			// all of them to see if any of them are an admin email.
			// if any of them are, mark this user as an admin.
			_.each(_.pluck(newUser.get("emails"), "value"), _.bind(function(email) {
				if(this.options.ADMIN_EMAILS.indexOf(email) > -1) {
					logger.info("Detected login from blessed email account("+this.options.ADMIN_EMAILS+"), granting admin rights.");
					newUser.set("admin", true);
				}
			}, this));
			
			newUser.save();
			this.db.users.add(newUser);

			logger.debug("users.length" + this.db.users.length);

			return done(null, newUser.toJSON());
		}, this)));
		
		// we don't need to do anything in serialize, because we write
		// the user to redis when it's created (above) and update that
		// throughout the app. So nothing special to do on logout.
		passport.serializeUser(_.bind(function(user, done) {
			done(null, user.id);
		}, this));
		
		// this part gets existing users from memory
		passport.deserializeUser(_.bind(function(id, done) {
			var user = this.db.users.get(id);
			if(_.isNull(user)) {
				logger.error("Tried to deserialize a user that did not exist; user:" + id);
				done(new Error('user/' + id + " does not exist."));
			} else {
				done(null, user);
			}
		}, this));
		
		var redisSessionStore = new RedisStore({client:this.db.redis});
		
		// setup the templating engine
		this.express.engine('.ejs', require('ejs').__express);
		this.express.set('views', __dirname + '/../views');
		this.express.set('view engine', 'html');
		
		// express basics. bodyParser is important - makes it easier to extract
		// post parameters from POST requests.
		this.express.use(express.cookieParser());
		this.express.use(express.bodyParser());

		// make sessions available, using redis.
		// expiration is now set to 2 days, to avoid buildup. It seems like the
		// heartbeat messages are causing sessions to be created for each request, which is
		// overloading the session store. 
		this.express.use(express.session({ secret: this.options.SESSION_SECRET, store:redisSessionStore, cookie: {maxAge:1000*60*60*24*2}}));

        if (this.options.mockAuth) {
            var mockPassport = require("./passport-mock");
            this.express.use(mockPassport.mockAuthMiddleware(this));
        }
		
        this.express.use(passport.initialize());

		// plug in the authentication system.
		this.express.use(passport.session());

		// allow cross domain posting from google hangout apps
		// this should be more specific than "*", but the CORS protocol is
		// quite stingy in what it will accept here:
        // http://stackoverflow.com/questions/14003332/access-control-allow-origin-wildcard-subdomains-ports-and-protocols
		// what we really want to do is allow https requests if we're in https mode, and http request
		// if not, and only from *.googleusercontent.com, but that's proving to be very
		// tricky to get to work. For now, leaving this as a wildcard, though we
		// definitely need to look it down more later.
		this.express.use(allowCrossDomain("*"));

        // Compilation of stylus files
        this.express.use(stylus.middleware({
            src: __dirname + "/../",
            compile: function(str, path) {
                return stylus(str).set('filename', path).use(nib()).import('nib');
            }
        }));

        //
        // Routes
        //

		// do static serving from /public 
		this.express.use("/public", express.static(__dirname + "/../public"));
        unhangoutRoutes.route(this.express, this.db, this.options);
        permalinkRoutes.route(this.express, this.db, this.options);
		farming.init(this.express, this.db, this.options);
		
		this.http.listen(process.env.PORT || this.options.PORT);
		if(this.options.timeoutHttp) {
			this.http.setTimeout(400);
		}

		logger.info("http server listening");
		
		this.emit("started");
		this.running = true;
	},
	
	// stops the unhangout server. 
	stop: function() {
		if(!this.running) {
			logger.warn("Tried to stop a server that was not running.");
			this.emit("error", "Tried to stop a server that was not running.");
			return;
		}
		logger.info("Stopping UnhangoutServer!");

        this.socketManager.shutdown(_.bind(function(err, message) {
            if (err) {
                logger.error(err)
            }
			if(this.httpRedirect) {
				this.httpRedirect.close();
			}

			this.http.close();

			this.http.on("close", _.bind(function() {
				this.running = false;
				this.emit("stopped");
				}, this));
        }, this));
	},
	
	destroy: function() {
		this.express = null;
		this.http = null;
        this.socketManager = null;

		this.httpRedirect = null;
				
		logger.info("destroyed");
		this.emit("destroyed");
	}
}


// Mix in the node events structures so we have on/emit available on the server.
// This is helpful for testing and various other sorts of indirection.
_.extend(exports.UnhangoutServer.prototype, EventEmitter.prototype);
