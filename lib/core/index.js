'use strict';

const fs = require('fs');
const ect = require('ect');
const path = require('path');
const compression = require('compression');
const express = require('express');
const router = express.Router();
const morgan = require('morgan');
const favicon = require('serve-favicon');
const underscore = require('underscore');
const moment = require('moment');

const bodyParser = require('body-parser');
require('body-parser-xml')(bodyParser);

const flash = require('connect-flash');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');

const token = require('./_token');
const route = require('./_route');
const logger = require('./_logger');

const config = {};

function __mkdirsSync(dirname, mode) {
    if (fs.existsSync(dirname)) {
        return true;
    } else {
        if (__mkdirsSync(path.dirname(dirname), mode)) {
            fs.mkdirSync(dirname, mode);
            return true;
        }
    }
    return false;
}

function __config(conf) {
    if (typeof (conf) == 'string') {
        var _config = require(conf);
        _config.root = path.dirname(conf);
        Object.assign(config, _config)
    } else {
        Object.assign(config, conf)
    }
}

const __use = function (app, middleware) {
    if (!middleware) {
        return;
    }

    if (typeof (middleware) == 'function') {
        app.use(middleware);
    }

    if (middleware instanceof Array) {
        for (var i in middleware) {
            __use(app, middleware[i]);
        }
    }
}

function start(conf) {

    __config(conf);

    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            underscore.extend(config, arguments[i]);
        }
    }

    config.viewEngine = config.viewEngine || 'html';

    var app = express();

    if (config.init && typeof config.init === 'function') {
        config.init(app);
    }

    app.use(compression());

    var env = config.env || process.env.NODE_ENV || 'development'

    var log = logger({ root: path.join(config.root, config.logs) });

    var errLogger = log.get('error');

    var accessLogger = log.get('access');

    app.set('name', config.name);
    app.set('port', config.port);

    // cross-origin
    app.use(cors());

    // views engine
    if (config.views) {
        app.set('views', path.join(config.root, config.views));
        app.set('view engine', config.viewEngine);
        var engine = config.engine || ect({
            watch: true,
            root: path.join(config.root, config.views)
        }).render;
        app.engine(config.viewEngine, engine);
    }

    if (config.favicon) {
        app.use(favicon(path.join(config.root, config.favicon)));
    }

    app.use(morgan(env == 'development' ? 'dev' : 'common', {
        skip: function (req, res) {
            return res.statusCode < 400;
        }
    }));

    if (config.static) {
        for (var i in config.static) {
            app.use(express.static(path.join(config.root, config.static[i])));
        }
    }

    app.use(helmet());
    app.use(flash());

    // body parser
    app.use(bodyParser.json({ limit: '10000kb' }));
    app.use(bodyParser.xml({ limit: '10000kb', xmlParseOptions: { normalize: true, explicitArray: false } }));
    app.use(bodyParser.urlencoded({
        extended: false
    }));

    __use(app, [
        function (req, res, next) {
            req.config = config;
            req.all = Object.assign({}, req.query, req.body);
            return next();
        }
    ]);

    if (config.beforeRoute) {
        __use(app, config.beforeRoute);
    }

    // register routes
    if (config.routes instanceof Array) {
        for (var i in config.routes) {
            route.inject(router, path.join(config.root, config.routes[i]));
        }
    } else if (typeof (config.routes == 'string')) {
        route.inject(router, path.join(config.root, config.routes));
    }

    app.use('/', router);

    // catch 404 and forward to error handler
    app.use(function (req, res, next) {
        var err404 = new Error('Not Found');
        err404.status = 404;
        next(err404);
    });

    // error logger
    app.use(function (err, req, res, next) {
        if (err.status == 404) {
            accessLogger && accessLogger.info(req._remoteAddress + ' 404 GET ' + req.originalUrl);
        } else {
            errLogger && errLogger.error(err.stack);
        }
        next(err);
    });

    if (config.afterRoute) {
        __use(app, config.afterRoute);
    }

    app.listen(app.get('port'));
    console.log("SERVER : " + app.get('name') + ' started on port ' + app.get('port'));

    return app;
}

function getConfig() {
    return config;
}

function createToken(user, secretKey) {
    return token.createToken(user, secretKey || config.tokenSecretKey || 'token-secret-key');
}

function verifyToken(jwt, expireIn, secretKey) {
    return token.authenticate(jwt, expireIn || config.tokenExpireIn || 30 * 86400, secretKey || config.tokenSecretKey || 'token-secret-key');
}

function createAuthRoute(expireIn, secretKey) {
    return function (req, res, next) {
        let bearer = req.query.auth_token;
        if (!bearer) {
            var authorization = req.headers['authorization'];
            if (authorization && authorization.startsWith('Bearer ')) {
                bearer = authorization.substring('Bearer '.length);
            }
        }
        if (bearer) {
            req.authUser = token.authenticate(bearer, expireIn || config.tokenExpireIn || 30 * 86400, secretKey || config.tokenSecretKey || 'token-secret-key');
            next();
        } else {
            next();
        }
    }
}

function getTempDir(...dirs) {
    let cacheDir = path.join(config.root, 'temp', ...dirs);
    __mkdirsSync(cacheDir);
    return cacheDir;
}

function createUploadRoute(handle) {
    let multerStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            let dateDir = moment().format('YYYYMMDD');
            return cb(null, getTempDir(config.upload || 'assets/upload', dateDir));
        },
        filename: function (_req, file, cb) {
            var newName = Date.now() + '-' + Math.random().toString(36).slice(2, 9) + path.extname(file.originalname)
            return cb(null, newName);
        }
    });
    let preUpload = multer({ storage: multerStorage }).single(config.uploadFieldName || 'upload');
    let afterUpload = function (req, res, next) {
        let callNext = () => {
            res.send({
                url: req.file.path.replace(config.root, ''),
                ext: path.extname(req.file.originalname)
            });
        }
        if (handle) {
            handle(req, res, callNext);
        } else {
            res.send('Error');
        }
    }
    return [preUpload, afterUpload];
}

module.exports = {
    start,
    getConfig,
    getTempDir,
    createToken,
    verifyToken,
    createAuthRoute,
    createUploadRoute,
}