import proj4 from 'proj4';
import { register as registerProj4 } from 'ol/proj/proj4.js';
import Projection from 'ol/proj/Projection.js';
import { get as getProjection } from 'ol/proj.js';

// Known EPSG code definitions as fallback
const KNOWN_EPSG_DEFS: Record<string, string> = {
  '4326': '+proj=longlat +datum=WGS84 +no_defs +type=crs',
  '3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs',
  '7844': '+proj=longlat +ellps=GRS80 +no_defs +type=crs', // GDA2020
  '28354': '+proj=utm +zone=54 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 Zone 54
  '28355': '+proj=utm +zone=55 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs', // GDA94 Zone 55
  '32654': '+proj=utm +zone=54 +datum=WGS84 +units=m +no_defs +type=crs', // WGS84 UTM Zone 54N
  '32655': '+proj=utm +zone=55 +datum=WGS84 +units=m +no_defs +type=crs', // WGS84 UTM Zone 55N
};

/**
 * Converts WKT projection string to proj4 format and registers it.
 * Returns the projection identifier to use (e.g., 'EPSG:7844' or custom ID).
 */
export async function registerProjectionFromWKT(wkt: string): Promise<Projection | null> {
  
  // Extract EPSG code from WKT
  const authorityMatch = wkt.match(/AUTHORITY\["EPSG","?(\d+)"?\]/g);
  
  if (!authorityMatch) {
    // No EPSG authority, try to parse WKT manually
    return registerFromWKT(wkt, 'CUSTOM_' + Date.now());
  }
  
  // Get the last EPSG authority (which is typically the projection's code)
  const lastAuthority = authorityMatch[authorityMatch.length - 1];
  const epsgCode = lastAuthority.match(/(\d+)/)?.[0];
  
  if (!epsgCode) {
    return registerFromWKT(wkt, 'CUSTOM_' + Date.now());
  }
  
  const epsgId = `EPSG:${epsgCode}`;
  
  // Check if proj4 already knows this projection
  try {
    const existing = proj4.defs(epsgId);
    if (existing) {
      const proj = getProjection(epsgId);
      return proj || new Projection({ code: epsgId });
    }
  } catch (e) {
    // Not registered, continue
  }
  
  // Try known EPSG definitions first
  if (KNOWN_EPSG_DEFS[epsgCode]) {
    const proj4String = KNOWN_EPSG_DEFS[epsgCode];
    proj4.defs(epsgId, proj4String);
    const proj = getProjection(epsgId);
    return proj || new Projection({ code: epsgId });
  }
  
  // Try to fetch from epsg.io
  try {
    const response = await fetch(`https://epsg.io/${epsgCode}.proj4`);
    if (response.ok) {
      const proj4String = await response.text();
      proj4.defs(epsgId, proj4String);
      const proj = getProjection(epsgId);
      return proj || new Projection({ code: epsgId });
    }
  } catch (e) {
    console.warn(`[ProjectionHelper] Failed to fetch ${epsgId} from epsg.io, will try manual parsing`);
  }
  
  // Fallback: parse WKT manually
  return registerFromWKT(wkt, epsgId);
}

/**
 * Parses WKT and constructs a proj4 string manually.
 */
function registerFromWKT(wkt: string, identifier: string): Projection {
  console.log(`[PROJ DEBUG] registerFromWKT called with identifier:`, identifier);
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
  
  // Extract false easting/northing
  const falseEastingMatch = wkt.match(/FALSEEASTING\[([\d.]+)\]/);
  if (falseEastingMatch) {
    proj4Parts.push(`+x_0=${falseEastingMatch[1]}`);
  }
  
  const falseNorthingMatch = wkt.match(/FALSENORTHING\[([\d.]+)\]/);
  if (falseNorthingMatch) {
    proj4Parts.push(`+y_0=${falseNorthingMatch[1]}`);
  }
  
  // Extract central meridian
  const centralMeridianMatch = wkt.match(/CENTRALMERIDIAN\[([\d.-]+)\]/);
  if (centralMeridianMatch) {
    proj4Parts.push(`+lon_0=${centralMeridianMatch[1]}`);
  }
  
  // Extract scale factor
  const scaleFactorMatch = wkt.match(/SCALEFACTOR\[([\d.]+)\]/);
  if (scaleFactorMatch) {
    proj4Parts.push(`+k_0=${scaleFactorMatch[1]}`);
  }
  
  // Extract standard parallels for Lambert
  const stdParallel1Match = wkt.match(/STANDARDPARALLEL\["([^"]+)",([\d.]+)\]/);
  if (stdParallel1Match) {
    proj4Parts.push(`+lat_1=${stdParallel1Match[2]}`);
  }
  
  // Extract latitude of origin
  const latOriginMatch = wkt.match(/LATITUDEOFORIGIN\[([\d.-]+)\]/);
  if (latOriginMatch) {
    proj4Parts.push(`+lat_0=${latOriginMatch[1]}`);
  }
  
  proj4Parts.push('+no_defs');
  proj4Parts.push('+type=crs');
  
  const proj4String = proj4Parts.join(' ');
  console.log(`[PROJ DEBUG] Registering proj4 string:`, proj4String);
  
  proj4.defs(identifier, proj4String);
  const proj = getProjection(identifier);
  return proj || new Projection({ code: identifier });
}

/**
 * Registers a projection from an EPSG code by fetching from epsg.io.
 * Returns the EPSG identifier string (e.g., 'EPSG:7844') or null on failure.
 */
export async function registerProjectionFromEPSGCode(epsgCode: string | number): Promise<Projection | null> {
  const code = typeof epsgCode === 'string' ? epsgCode.replace('EPSG:', '') : epsgCode.toString();
  const epsgId = `EPSG:${code}`;


  // Check if proj4 already has this projection registered
  try {
    const existing = proj4.defs(epsgId);
    if (existing) {
      const proj = getProjection(epsgId);
      return proj || new Projection({ code: epsgId });
    }
  } catch (e) {
    // Not registered, continue
  }

  // Try known EPSG definitions first
  if (KNOWN_EPSG_DEFS[code]) {
    const proj4String = KNOWN_EPSG_DEFS[code];
    proj4.defs(epsgId, proj4String);
    const proj = getProjection(epsgId);
    return proj || new Projection({ code: epsgId });
  }

  // Fetch from epsg.io
  try {
    const response = await fetch(`https://epsg.io/${code}.proj4`);
    if (response.ok) {
      const proj4String = await response.text();
      proj4.defs(epsgId, proj4String);
      const proj = getProjection(epsgId);
      return proj || new Projection({ code: epsgId });
    }
  } catch (e) {
    console.warn(`[ProjectionHelper] Failed to fetch ${epsgId} from epsg.io:`, e);
  }

  return null;
}
