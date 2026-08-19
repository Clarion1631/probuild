const RealDate = Date;
const fixedTimestamp = RealDate.parse("2031-04-05T00:00:00.000Z");

global.Date = class FixedDate extends RealDate {
    constructor(...args) {
        super(...(args.length === 0 ? [fixedTimestamp] : args));
    }

    static now() {
        return fixedTimestamp;
    }
};
