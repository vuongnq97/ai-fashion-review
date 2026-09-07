'use strict';

module.exports = {
  ...require('./config'),
  ...require('./contracts'),
  ...require('./asset-normalizer'),
  ...require('./product-truth'),
  ...require('./category-router'),
  ...require('./visual-feasibility'),
  ...require('./continuity-pack'),
  ...require('./qa'),
  ...require('./storyboard-compositor'),
  ...require('./post-process'),
  ...require('./orchestrator'),
};
