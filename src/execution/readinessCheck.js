const {
  checkRealRunReadiness,
  dryRunAuditEvidence,
} = require("../core/readinessChecker");

module.exports = {
  checkExecutionReadiness: checkRealRunReadiness,
  checkRealRunReadiness,
  dryRunAuditEvidence,
};
