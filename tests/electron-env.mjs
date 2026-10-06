/** Environment for the Electron GUI tests: windows are created hidden (see TEST_HIDDEN in electron/main.cjs) so the
 * suite does not flash windows on the developer's display. To watch a run, set MATHSLIDES_TEST_VISIBLE=1. */
export const testElectronEnv = (extra = {}) => ({
  ...process.env,
  ...(process.env.MATHSLIDES_TEST_VISIBLE ? {} : { MATHSLIDES_TEST_HIDDEN: '1' }),
  ...extra,
});
