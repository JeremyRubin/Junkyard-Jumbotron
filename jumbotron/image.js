// ======================================================================
// Image

var fs = require('fs');
var path = require('path');
var url = require('url');
var gm = require('gm');
var params = require('./params');
var utils = require('./utils');
var Queue = require('./queue');
var Base = require('./base');
var Viewport = require('./viewport');
var exec = require('child_process').exec;

// Constructor
function Image(options) {
    Base.call(this, options);

    // options can be a string, a list of options, or nothing
    options = options || {};

    // Parent pointer
    this.jumbotron = options.jumbotron;

    // URL
    this.source = utils.isString(options) ? options : options.source;

    // Size
    this.width = options.width || 0;
    this.height = options.height || 0;

    // Format (jpeg, ...)
    this.format = options.format || "";

    // Viewport that the jumbotron uses to display this image
    this.viewport = options.viewport
	? new Viewport(options.viewport)
	: new Viewport({ width: this.width, height: this.height });

    // On or off
    this.active = options.active || true;
}

// ----------------------------------------------------------------------
// Subclass and Members

Image.prototype = utils.inherits(Base, {
    
    // Serialize
    toJSON: function toJSON() {
	var ret = Base.prototype.toJSON.call(this);
	ret.source = this.source;
	ret.width = this.width;
	ret.height = this.height;
	ret.viewport = this.viewport;
	ret.active = this.active;
	return ret;
    },

    init: function init(cb) {

	// Try to identify the file
	var gmImg = gm(this.source);
	gmImg.identify(function(err, data) {
	    if (err) {
		if (err.code == 1)
		    err = 'bad image';
		return cb && cb(err);
	    }
	    if (! (data.format &&
		   data.format.toLowerCase() in params.allowedFileTypes))
		return cb && cb('bad image');

	    // Save format info
	    this.format = data.format;
	    this.width = data.size.width;
	    this.height = data.size.height;
	    this.viewport = new Viewport(data.size);
	    // TODO? check if ext and format don't match

	    // Reorient if needed
	    if (data.exif) {
		var angle = {1:0, 3:180, 6:90, 8:270}[data.exif.orientation];
		if (angle) {
		    // Transpose width and height
		    if (angle != 180) {
			this.width = data.size.height;
			this.height = data.size.width;
		    }
		    return gmImg.rotate("black", angle).write(this.source, cb);
		}
	    }
	    cb && cb(err);
	}.bind(this));
    },

    makeThumbnail: function makeThumbnail(size, cb) {
	Image.makeThumbnail(this.source, size, cb);
    }
});

// ----------------------------------------------------------------------
// Class Members
// For lack of a better place, these image getters are here.

var errorImage = null;

// Image shown when a display wasn't found during calibration.
// Cached since it can be shared.
Image.getErrorImage = function getErrorImage() {
    if (! errorImage)
	errorImage = new Image(params.errorImageOptions);
    return errorImage;
};

// Calibration image, shown when a jumbotron is first calibrated.
// Can't be cached since user might change viewport.
Image.getCalibratedImage = function getCalibratedImage() {
    return new Image(params.calibratedImageOptions);
};

// Sample images
Image.getSampleImageFiles = function getSampleImageFiles(cb) {
    fs.readdir(params.samplesDir, function(err, files) {
	if (err)
	    return cb(err);
	var legitExtensions =  {'.jpg':1, '.gif':1, '.png':1 };
	var fullFiles = [];
	for (var f = 0; f < files.length; f++) {
	    if (path.extname(files[f]) in legitExtensions)
		fullFiles.push(path.join(params.samplesDir, files[f]));
	}
	cb(null, fullFiles);
    });
};

Image._makeThumbnail = function _makeThumbnail(src, dst, width, height, cb) {
    var scale_x = width*0.1;
    var scale_y = height*0.1;
    var comm = 'ffmpeg -y -i '+ src + ' -ss 0 -vframes 1 -s ' + 150 + "x" + 150 + ' -an '+ dst;
    exec(comm, function(err, stdout, stderr) {
        if (err){
	        return callback.call(err, stdout, stderr, comm);
        }
    });
};

Image.makeThumbnail = function makeThumbnail(fileName, size, cb) {
    var dirName = path.dirname(fileName);
    var thumbnailDirName = path.join(dirName, 'tn');
    var thumbnailFileName = path.join(thumbnailDirName, path.basename(fileName));

    path.exists(thumbnailFileName, function(exists) {
	if (exists)
	    return cb && cb(null, thumbnailFileName);
	fs.mkdir(thumbnailDirName, 0755, function(err) {
	    // Ignore directory-already-exists error
	    Image._makeThumbnail(fileName, thumbnailFileName, size, size, function(err) {
		cb && cb(err, thumbnailFileName);
	    });
	});
    });
};

// ----------------------------------------------------------------------
// Export

module.exports = Image;

// ----------------------------------------------------------------------

// gm identify ignores exif tags
gm.prototype.identify = function(callback){
    var self = this;
    if (!callback)
	return self;
    if (self._identifying) {
	self._iq.push(callback);
	return self;
    }
    if (Object.keys(self.data).length)  {
	callback.call(self, null, self.data);
	return self;
    }
    self._iq = [callback];
    self._identifying = true;
    var cmd = "gm identify -ping -verbose " + self.source;
    self._exec(cmd, function(err, stdout, stderr) {
	if (err)
	    return callback.call(self, err, stdout, stderr, cmd);
	stdout = (stdout||"").trim().replace(/\r\n|\r/g, "\n");
	var parts = stdout.split("\n")
	, rgx = /^( *)([-a-zA-Z0-9 ]*): *(.*)/
	, data = self.data
	, cur
	, handle = {
	    'geometry': function(val) {
		var split = val.split("x");
		data.size = 
		    { width : parseInt(split[0], 10),
		      height: parseInt(split[1], 10) 
		    };
            },
            'format': function(val) {
		data.format = val.split(" ")[0].toLowerCase();
            },
            'depth': function(val) {
		data.depth = parseInt(val, 10);
            },
            'colors': function(val) {
		data.color = parseInt(val, 10);
            },
            'resolution': function(val) {
		data.res = val;
            },
            'filesize': function(val) {
		data.filesize = val;
            },
	    'profile-exif': function(cal) {
		data.exif = {};
		return data.exif;
	    }
        };
	for (var i = 0, len = parts.length; i < len; ++i){
	    var result = rgx.exec(parts[i]);
	    if (result) {
		var indent = result[1].length / 2;
		var key = result[2].toLowerCase();
		var val = result[3];
		if (1 == indent){
		    var handler = handle[key];
		    if (handler) {
			cur = handler(val);
		    }
		    else if (val) {
			data[key] = val;
			cur = null;
		    }
		    else {
			cur = data[key] = {};
		    }
		}
		else if (2 == indent) {
		    if (cur)
			cur[key] = val;
		}
	    }
	}
	var idx = self._iq.length;
	while (idx--)
	    self._iq[idx].call(self, null, self.data);
	self._identifying = false;
    });
    return self;
};
