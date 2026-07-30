import proj4 from 'proj4';
import { register as registerProj4 } from 'ol/proj/proj4.js';
import Projection from 'ol/proj/Projection.js';
import { get as getProjection } from 'ol/proj.js';

// Known EPSG code definitions as fallback
const KNOWN_EPSG_DEFS: Record<string, string> = {
  '4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
  '3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs',
  '7844': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs +type=crs', // GDA2020
  '7846': '+proj=utm +zone=46 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 46
  '7847': '+proj=utm +zone=47 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 47
  '7848': '+proj=utm +zone=48 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 48
  '7849': '+proj=utm +zone=49 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 49
  '7850': '+proj=utm +zone=50 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 50
  '7851': '+proj=utm +zone=51 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 51
  '7852': '+proj=utm +zone=52 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 52
  '7853': '+proj=utm +zone=53 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 53
  '7854': '+proj=utm +zone=54 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 54
  '7855': '+proj=utm +zone=55 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 55
  '7856': '+proj=utm +zone=56 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 56
  '7857': '+proj=utm +zone=57 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 57
  '7858': '+proj=utm +zone=58 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 58
  '7859': '+proj=utm +zone=59 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA2020 / MGA zone 59
  '28348': '+proj=utm +zone=48 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 48
  '28349': '+proj=utm +zone=49 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 49
  '28350': '+proj=utm +zone=50 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 50
  '28351': '+proj=utm +zone=51 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 51
  '28352': '+proj=utm +zone=52 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 52
  '28353': '+proj=utm +zone=53 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 53
  '28354': '+proj=utm +zone=54 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 54
  '28355': '+proj=utm +zone=55 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 55
  '28356': '+proj=utm +zone=56 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 / MGA zone 56
  '32654': '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs +type=crs', // WGS84 UTM Zone 54N
  '32655': '+proj=utm +zone=55 +datum=WGS84 +units=m +no_defs +type=crs', // WGS84 UTM Zone 55N
};

/**
 * Attempts to identify a PROJCS WKT as a known EPSG code based on the
 * PROJCS name and/or its projection parameters. Returns the EPSG code or null.
 */
function identifyEPSGFromWKT(wkt: string): string | null {
  // Try to extract PROJCS name
  const projcsNameMatch = wkt.match(/^PROJCS\["([^"]+)"/);
  const projcsName = projcsNameMatch?.[1]?.toLowerCase() || '';

  // Try to extract projection name
  const projMatch = wkt.match(/PROJECTION\["([^"]+)"\]/);
  const projName = projMatch?.[1] || '';

  // Extract datum name (handles both "D_GDA2020" and "GDA2020" style)
  const datumMatch = wkt.match(/DATUM\["([^"]+)"/);
  const datumName = datumMatch?.[1]?.replace(/^D_/, '').toLowerCase() || '';

  // Extract spheroid
  const spheroidMatch = wkt.match(/SPHEROID\["([^"]+)"/);
  const spheroidName = spheroidMatch?.[1]?.toLowerCase() || '';

  // Extract PARAMETER values (ESRI format: PARAMETER["name",value])
  const getParam = (name: string): number | null => {
    const re = new RegExp(`PARAMETER\\["${name}"\\s*,\\s*([\\d.\\-]+)\\]`, 'i');
    const m = wkt.match(re);
    return m ? parseFloat(m[1]) : null;
  };

  const scale_factor = getParam('scale_factor');
  const central_meridian = getParam('central_meridian');
  const latitude_of_origin = getParam('latitude_of_origin');
  const false_easting = getParam('false_easting');
  const false_northing = getParam('false_northing');

  // GDA2020 MGA zones: Transverse Mercator, scale=0.9996, false_easting=500000, false_northing=10000000
  // Central meridians: zone 48=105, 49=111, 50=117, 51=123, 52=129, 53=135, 54=141, 55=147, 56=153, 57=159, 58=165
  if (
    (datumName.includes('gda2020') || spheroidName.includes('grs_1980') || projcsName.includes('gda2020')) &&
    projName.toLowerCase() === 'transverse_mercator' &&
    scale_factor === 0.9996 &&
    false_easting === 500000 &&
    false_northing === 10000000 &&
    central_meridian !== null
  ) {
    const zoneMap: Record<number, number> = {
      93: 7846, 99: 7847, 105: 7848, 111: 7849, 117: 7850, 123: 7851,
      129: 7852, 135: 7853, 141: 7854, 147: 7855, 153: 7856, 159: 7857, 165: 7858,
    };
    const epsg = zoneMap[central_meridian];
    if (epsg) return String(epsg);
  }

  // GDA94 MGA zones: same structure but different datum
  if (
    datumName.includes('gda_1994') || datumName.includes('gda94') || datumName.includes('gda_94')
  ) {
    if (
      projName.toLowerCase() === 'transverse_mercator' &&
      scale_factor === 0.9996 &&
      false_easting === 500000 &&
      false_northing === 10000000 &&
      central_meridian !== null
    ) {
      const zoneMap: Record<number, number> = {
        105: 28348, 111: 28349, 117: 28350, 123: 28351, 129: 28352,
        135: 28353, 141: 28354, 147: 28355, 153: 28356, 159: 28357, 165: 28358,
      };
      const epsg = zoneMap[central_meridian];
      if (epsg) return String(epsg);
    }
  }

  // Check PROJCS name for direct matches
  const namePatterns: [RegExp, string][] = [
    [/gda2020.*mga.*zone\s*46/i, '7846'],
    [/gda2020.*mga.*zone\s*47/i, '7847'],
    [/gda2020.*mga.*zone\s*48/i, '7848'],
    [/gda2020.*mga.*zone\s*49/i, '7849'],
    [/gda2020.*mga.*zone\s*50/i, '7850'],
    [/gda2020.*mga.*zone\s*51/i, '7851'],
    [/gda2020.*mga.*zone\s*52/i, '7852'],
    [/gda2020.*mga.*zone\s*53/i, '7853'],
    [/gda2020.*mga.*zone\s*54/i, '7854'],
    [/gda2020.*mga.*zone\s*55/i, '7855'],
    [/gda2020.*mga.*zone\s*56/i, '7856'],
    [/gda2020.*mga.*zone\s*57/i, '7857'],
    [/gda2020.*mga.*zone\s*58/i, '7858'],
    [/gda2020.*mga.*zone\s*59/i, '7859'],
    [/gda94.*mga.*zone\s*50/i, '28350'],
    [/gda94.*mga.*zone\s*51/i, '28351'],
    [/gda94.*mga.*zone\s*52/i, '28352'],
    [/gda94.*mga.*zone\s*53/i, '28353'],
    [/gda94.*mga.*zone\s*54/i, '28354'],
    [/gda94.*mga.*zone\s*55/i, '28355'],
    [/gda94.*mga.*zone\s*56/i, '28356'],
    [/wgs.*84.*utm.*zone\s*54.*n/i, '32654'],
    [/wgs.*84.*utm.*zone\s*55.*n/i, '32655'],
    [/wgs.*84.*utm.*zone\s*54.*s/i, '32754'],
    [/wgs.*84.*utm.*zone\s*55.*s/i, '32755'],
  ];

  for (const [pattern, code] of namePatterns) {
    if (pattern.test(projcsName)) {
      return code;
    }
  }

  return null;
}

/**
 * Helper: register a proj4 definition and then re-register proj4 with OpenLayers
 * so that OL picks up the new projection and sets up coordinate transforms.
 */
function registerProj4Def(epsgId: string, proj4String: string): Projection {
  proj4.defs(epsgId, proj4String);
  registerProj4(proj4);
  return getProjection(epsgId) || new Projection({ code: epsgId });
}

/**
 * Converts WKT projection string to proj4 format and registers it.
 * Returns the projection identifier to use (e.g., 'EPSG:7844' or custom ID).
 */
export async function registerProjectionFromWKT(wkt: string): Promise<Projection | null> {
  
  // Extract EPSG code from WKT AUTHORITY tag
  const authorityMatch = wkt.match(/AUTHORITY\["EPSG","?(\d+)"?\]/g);
  
  let epsgCode: string | null = null;

  if (authorityMatch) {
    // Get the last EPSG authority (which is typically the projection's code)
    const lastAuthority = authorityMatch[authorityMatch.length - 1];
    epsgCode = lastAuthority.match(/(\d+)/)?.[0] || null;
  }

  // If no AUTHORITY tag, try to identify the EPSG code from WKT content
  if (!epsgCode) {
    const identified = identifyEPSGFromWKT(wkt);
    if (identified) {
      epsgCode = identified;
      console.log(`[ProjectionHelper] Identified EPSG:${epsgCode} from WKT content`);
    }
  }

  if (epsgCode) {
    const epsgId = `EPSG:${epsgCode}`;
    
    // Check if this projection is already fully registered with OL
    const existing = getProjection(epsgId);
    if (existing) {
      return existing;
    }
    
    // Try known EPSG definitions first
    if (KNOWN_EPSG_DEFS[epsgCode]) {
      return registerProj4Def(epsgId, KNOWN_EPSG_DEFS[epsgCode]);
    }
    
    // Try to fetch from epsg.io
    try {
      const response = await fetch(`https://epsg.io/${epsgCode}.proj4`);
      if (response.ok) {
        const proj4String = await response.text();
        return registerProj4Def(epsgId, proj4String);
      }
    } catch (e) {
      console.warn(`[ProjectionHelper] Failed to fetch ${epsgId} from epsg.io, will try manual parsing`);
    }
  }
  
  // Fallback: parse WKT manually
  const identifier = epsgCode ? `EPSG:${epsgCode}` : 'CUSTOM_' + Date.now();
  return registerFromWKT(wkt, identifier);
}

/**
 * Extracts a parameter value from WKT, supporting both formats:
 * - ESRI format: PARAMETER["name",value]
 * - GDAL/OGR format: KEYWORD[value]
 */
function getWKTParameter(wkt: string, paramName: string, keyword?: string): number | null {
  // Try ESRI PARAMETER format first: PARAMETER["name",value]
  const esriRe = new RegExp(`PARAMETER\\["${paramName}"\\s*,\\s*([\\d.\\-]+)\\]`, 'i');
  const esriMatch = wkt.match(esriRe);
  if (esriMatch) return parseFloat(esriMatch[1]);

  // Try GDAL/OGR keyword format: KEYWORD[value]
  if (keyword) {
    const gdalRe = new RegExp(`${keyword}\\[([\\d.\\-]+)\\]`, 'i');
    const gdalMatch = wkt.match(gdalRe);
    if (gdalMatch) return parseFloat(gdalMatch[1]);
  }

  return null;
}

/**
 * Parses WKT and constructs a proj4 string manually.
 * Supports both ESRI WKT (PARAMETER["name",value]) and GDAL/OGR WKT (KEYWORD[value]).
 */
function registerFromWKT(wkt: string, identifier: string): Projection {
  const proj4Parts: string[] = [];
  
  // Detect geographic vs projected CRS
  const isGeographic = wkt.startsWith('GEOGCS');
  const isProjected = wkt.startsWith('PROJCS');
  
  if (isGeographic) {
    proj4Parts.push('+proj=longlat');
  } else if (isProjected) {
    // Try to extract projection method
    const projMatch = wkt.match(/PROJECTION\["([^"]+)"\]/);
    if (projMatch) {
      const projName = projMatch[1];
      // Map common projection names to proj4 equivalents
      const projMap: Record<string, string> = {
        'Transverse_Mercator': '+proj=tmerc',
        'Lambert_Conformal_Conic_1SP': '+proj=lcc',
        'Lambert_Conformal_Conic_2SP': '+proj=lcc',
        'Albers_Conic_Equal_Area': '+proj=aea',
        'Mercator_1SP': '+proj=merc',
        'Mercator_2SP': '+proj=merc',
        'Krovak': '+proj=krovak',
        'Stereographic': '+proj=stere',
        'Lambert_Azimuthal_Equal_Area': '+proj=laea',
      };
      proj4Parts.push(projMap[projName] || `+proj=${projName.toLowerCase()}`);
    }
  }
  
  // Extract ellipsoid parameters
  const spheroidMatch = wkt.match(/SPHEROID\["([^"]+)",([\d.]+),([\d.]+)/);
  if (spheroidMatch) {
    const spheroidName = spheroidMatch[1];
    const semiMajor = parseFloat(spheroidMatch[2]);
    const inverseFlattening = parseFloat(spheroidMatch[3]);
    
    // Map common ellipsoid names to proj4 codes
    const ellipsoidMap: Record<string, string> = {
      'GRS_1980': '+ellps=GRS80',
      'WGS_1984': '+ellps=WGS84',
      'Bessel_1841': '+ellps=bessel',
      'International_1924': '+ellps=intl',
    };
    
    const ellipsoidCode = ellipsoidMap[spheroidName];
    if (ellipsoidCode) {
      proj4Parts.push(ellipsoidCode);
    } else {
      proj4Parts.push(`+a=${semiMajor}`, `+rf=${inverseFlattening}`);
    }
  }

  // Extract datum name for towgs84 handling
  const datumMatch = wkt.match(/DATUM\["([^"]+)"/);
  const datumName = datumMatch?.[1]?.replace(/^D_/, '').toLowerCase() || '';
  
  // Extract projection parameters (supports both ESRI and GDAL/OGR WKT formats)
  const falseEasting = getWKTParameter(wkt, 'false_easting', 'FALSEEASTING');
  if (falseEasting !== null) proj4Parts.push(`+x_0=${falseEasting}`);

  const falseNorthing = getWKTParameter(wkt, 'false_northing', 'FALSENORTHING');
  if (falseNorthing !== null) proj4Parts.push(`+y_0=${falseNorthing}`);

  const centralMeridian = getWKTParameter(wkt, 'central_meridian', 'CENTRALMERIDIAN');
  if (centralMeridian !== null) proj4Parts.push(`+lon_0=${centralMeridian}`);

  const scaleFactor = getWKTParameter(wkt, 'scale_factor', 'SCALEFACTOR');
  if (scaleFactor !== null) proj4Parts.push(`+k_0=${scaleFactor}`);

  const latOrigin = getWKTParameter(wkt, 'latitude_of_origin', 'LATITUDEOFORIGIN');
  if (latOrigin !== null) proj4Parts.push(`+lat_0=${latOrigin}`);

  const stdParallel1 = getWKTParameter(wkt, 'standard_parallel_1', 'STANDARDPARALLEL1');
  if (stdParallel1 !== null) proj4Parts.push(`+lat_1=${stdParallel1}`);

  const stdParallel2 = getWKTParameter(wkt, 'standard_parallel_2', 'STANDARDPARALLEL2');
  if (stdParallel2 !== null) proj4Parts.push(`+lat_2=${stdParallel2}`);

  // Also try the old STANDARDPARALLEL format from previous code
  if (stdParallel1 === null) {
    const stdParallelMatch = wkt.match(/STANDARDPARALLEL\["([^"]+)",([\d.]+)\]/);
    if (stdParallelMatch) proj4Parts.push(`+lat_1=${stdParallelMatch[2]}`);
  }

  // Extract units from UNIT["Meter",1] or UNIT["Foot_US",0.3048006096012192]
  const unitMatch = wkt.match(/UNIT\["([^"]+)"\s*,\s*([\d.]+)/);
  if (unitMatch) {
    const unitName = unitMatch[1].toLowerCase();
    if (unitName.includes('meter') || unitName.includes('metre')) {
      proj4Parts.push('+units=m');
    } else if (unitName.includes('foot') || unitName.includes('feet')) {
      const conversionFactor = parseFloat(unitMatch[2]);
      proj4Parts.push(`+to_meter=${conversionFactor}`);
    }
  }

  // For geographic CRS based on GRS80, add towgs84 for datum transformation
  if (isGeographic && proj4Parts.includes('+ellps=GRS80')) {
    proj4Parts.push('+towgs84=0,0,0,0,0,0,0');
  }

  // For projected CRS with GRS80 ellipsoid, also add towgs84 for datum shift to WGS84
  if (isProjected && proj4Parts.includes('+ellps=GRS80')) {
    proj4Parts.push('+towgs84=0,0,0,0,0,0,0');
  }
  
  proj4Parts.push('+no_defs');
  proj4Parts.push('+type=crs');
  
  const proj4String = proj4Parts.join(' ');
  console.log(`[ProjectionHelper] WKT parsed to proj4: ${proj4String}`);
  
  proj4.defs(identifier, proj4String);
  registerProj4(proj4);
  return getProjection(identifier) || new Projection({ code: identifier });
}

/**
 * Registers a projection from an EPSG code by fetching from epsg.io.
 * Returns the EPSG identifier string (e.g., 'EPSG:7844') or null on failure.
 */
export async function registerProjectionFromEPSGCode(epsgCode: string | number): Promise<Projection | null> {
  const code = typeof epsgCode === 'string' ? epsgCode.replace('EPSG:', '') : epsgCode.toString();
  const epsgId = `EPSG:${code}`;

  // Check if already registered with OL
  const existing = getProjection(epsgId);
  if (existing) {
    return existing;
  }

  // Try known EPSG definitions first
  if (KNOWN_EPSG_DEFS[code]) {
    return registerProj4Def(epsgId, KNOWN_EPSG_DEFS[code]);
  }

  // Fetch from epsg.io
  try {
    const response = await fetch(`https://epsg.io/${code}.proj4`);
    if (response.ok) {
      const proj4String = await response.text();
      return registerProj4Def(epsgId, proj4String);
    }
  } catch (e) {
    console.warn(`[ProjectionHelper] Failed to fetch ${epsgId} from epsg.io:`, e);
  }

  return null;
}
