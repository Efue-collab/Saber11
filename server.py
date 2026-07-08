from flask import Flask, request, jsonify, send_from_directory
import sqlite3
import os
import json
import unicodedata
import numpy as np
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

app = Flask(__name__, static_folder='.', static_url_path='')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'saber11.db')
MAPPING_PATH = os.path.join(BASE_DIR, '../dane_mapping.json')

def normalize_str(s):
    if not s: return ""
    return "".join(c for c in unicodedata.normalize('NFD', str(s)) if unicodedata.category(c) != 'Mn').upper().strip()

# Load mapping once at startup
try:
    with open(MAPPING_PATH, encoding='utf-8') as _f:
        DANE_MAPPING = json.load(_f)
except Exception:
    DANE_MAPPING = {'deptos': {}, 'mcpios': {}}

# Build a normalized lookup: name → code (int)
_DEPTO_NAME_TO_CODE = {
    normalize_str(name): int(code)
    for code, name in DANE_MAPPING['deptos'].items()
}

# Constants for Socioeconomic Ranges (keys match frontend values)
HH_RANGES = {
    'small':  [0, 4],
    'medium': [4, 7],
    'large':  [7, 999]
}
EDU_RANGES = {
    'low':        [0, 4],
    'secondary':  [4, 7],
    'technical':  [7, 9],
    'university': [9, 999]
}

import re

def find_partition_files():
    files = [fname for fname in os.listdir(BASE_DIR) if fname.startswith('saber11_') and fname.endswith('.db')]
    year_files = [os.path.join(BASE_DIR, f) for f in files if re.match(r'^saber11_\d{4}\.db$', f)]
    range_files = [os.path.join(BASE_DIR, f) for f in files if re.match(r'^saber11_\d{4}-\d{4}\.db$', f)]
    return sorted(year_files + range_files)


def merge_grouped_rows(rows, key_field, avg_fields=None):
    avg_fields = avg_fields or ['avg_global', 'avg_mat', 'avg_lec', 'avg_cna', 'avg_soc', 'avg_ing']
    merged = {}
    for row in rows:
        key = row[key_field]
        if key is None:
            continue
        count = float(row.get('count') or 0)
        if key not in merged:
            merged[key] = {**row}
            merged[key]['count'] = count
            for field in avg_fields:
                merged[key][field] = float(row.get(field) or 0)
            continue
        existing = merged[key]
        prev_count = float(existing.get('count') or 0)
        total_count = prev_count + count
        if total_count <= 0:
            continue
        for field in avg_fields:
            existing[field] = ((float(existing.get(field) or 0) * prev_count) + (float(row.get(field) or 0) * count)) / total_count
        existing['count'] = total_count
    return list(merged.values())


def merge_sum_rows(rows, key_field, sum_fields):
    merged = {}
    for row in rows:
        key = row.get(key_field)
        if key is None:
            continue
        if key not in merged:
            merged[key] = {key_field: key}
            for field in sum_fields:
                merged[key][field] = float(row.get(field) or 0)
            continue
        existing = merged[key]
        for field in sum_fields:
            existing[field] += float(row.get(field) or 0)
    return list(merged.values())


def run_query(query, params=None):
    """Execute the SQL `query` across partition files if present, otherwise against `saber11.db`.
    Returns a list of sqlite3.Row-like dicts.
    """
    params = params or []
    parts = find_partition_files()
    results = []
    if parts:
        for p in parts:
            try:
                conn = sqlite3.connect(p)
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                cur.execute(query, params)
                rows = cur.fetchall()
                for r in rows:
                    results.append(dict(r))
            except Exception:
                pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        return results
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(query, params or [])
        rows = cur.fetchall()
        conn.close()
        return [dict(r) for r in rows]


def _compute_clusters_from_rows(rows):
    records = []
    for row in rows:
        code = row['code']
        if code in (None, ''):
            continue

        try:
            code_int = int(float(code))
        except (TypeError, ValueError):
            continue

        name = DANE_MAPPING.get('deptos', {}).get(str(code_int)) or DANE_MAPPING.get('deptos', {}).get(code_int)
        if not name or str(name).startswith('DEPTO_'):
            continue

        count = int(row['count'] or 0)
        if count <= 0:
            continue

        avg_global = float(row['avg_global'] or 0.0)
        pct_oficial = float(row['pct_oficial'] or 0.0)
        pct_rural = float(row['pct_rural'] or 0.0)
        pct_stratum12 = float(row['pct_stratum12'] or 0.0)
        avg_hh = float(row['avg_hh'] or 0.0)
        avg_fedu = float(row['avg_fedu'] or 0.0)
        avg_medu = float(row['avg_medu'] or 0.0)

        records.append({
            'name': name,
            'avg_global': avg_global,
            'pct_oficial': pct_oficial,
            'pct_rural': pct_rural,
            'pct_stratum12': pct_stratum12,
            'avg_hh': avg_hh,
            'avg_fedu': avg_fedu,
            'avg_medu': avg_medu,
        })

    if len(records) < 3:
        return {}

    features = [
        ['avg_global', 'pct_oficial', 'pct_rural', 'pct_stratum12', 'avg_hh', 'avg_fedu', 'avg_medu']
    ]
    matrix = np.array([[record[key] for key in features[0]] for record in records], dtype=float)
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)

    scaler = StandardScaler()
    scaled = scaler.fit_transform(matrix)

    k = min(3, len(records))
    kmeans = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = kmeans.fit_predict(scaled)

    cluster_means = {}
    for idx in sorted(set(labels.tolist())):
        mask = labels == idx
        cluster_means[idx] = float(np.mean(matrix[mask, 0]))

    ordered_clusters = sorted(cluster_means.keys(), key=lambda i: cluster_means[i], reverse=True)
    level_mapping = {}
    for position, cluster_idx in enumerate(ordered_clusters):
        if position == 0:
            level_mapping[cluster_idx] = 'Alto'
        elif position == 1:
            level_mapping[cluster_idx] = 'Medio'
        else:
            level_mapping[cluster_idx] = 'Vulnerable'

    clusters = {}
    for record, label in zip(records, labels):
        cluster_idx = int(label)
        level = level_mapping.get(cluster_idx, 'Medio')
        description = {
            'Alto': 'Alto Rendimiento & Fuerte Perfil Socioeconómico',
            'Medio': 'Rendimiento Medio & Perfil Socioeconómico Medio',
            'Vulnerable': 'Rendimiento Bajo & Perfil Socioeconómico Vulnerable',
        }.get(level, 'Rendimiento Medio & Perfil Socioeconómico Medio')
        clusters[record['name']] = {
            'cl': cluster_idx,
            'lv': level,
            'lb': description,
            'sc': round(record['avg_global'], 1),
            'po': round(record['pct_oficial'] * 100.0, 1),
            'pr': round(record['pct_rural'] * 100.0, 1),
            'ps': round(record['pct_stratum12'] * 100.0, 1),
            'hh_avg': round(record['avg_hh'], 2),
            'father_edu_avg': round(record['avg_fedu'], 2),
            'mother_edu_avg': round(record['avg_medu'], 2),
        }
    return clusters


def build_where_clause(filters):
    conditions = []
    params = []

    if filters.get('depto'):
        conditions.append("depto = ?")
        code = _DEPTO_NAME_TO_CODE.get(normalize_str(filters.get('depto')), -1)
        params.append(code)

    if filters.get('mcpio'):
        conditions.append("mcpio = ?")
        params.append(int(filters.get('mcpio')))

    if filters.get('year_start'):
        conditions.append("periodo >= ?")
        params.append(int(filters.get('year_start')) * 10)

    if filters.get('year_end'):
        conditions.append("periodo <= ?")
        params.append(int(filters.get('year_end')) * 10 + 9)

    era = filters.get('era')
    if era not in (None, '') and not filters.get('year_start') and not filters.get('year_end'):
        try:
            era_value = int(str(era).strip().rstrip('sS'))
            conditions.append("periodo >= ?")
            params.append(era_value * 10)
            conditions.append("periodo <= ?")
            params.append((era_value + 9) * 10 + 9)
        except ValueError:
            pass

    if filters.get('sem'):
        conditions.append("periodo % 10 = ?")
        params.append(int(filters.get('sem')))

    if filters.get('nature'):
        conditions.append("n = ?")
        val = filters.get('nature')
        params.append('O' if val == 'Oficial' else ('P' if val == 'No Oficial' else 'NR'))

    if filters.get('area'):
        conditions.append("a = ?")
        val = filters.get('area')
        params.append('U' if val == 'Urbano' else ('R' if val == 'Rural' else 'NR'))

    if filters.get('gender'):
        conditions.append("g = ?")
        val = filters.get('gender')
        params.append('F' if val == 'Femenino' else ('M' if val == 'Masculino' else 'NR'))

    if filters.get('stratum'):
        conditions.append("s = ?")
        params.append(int(filters.get('stratum')))

    # Apply socioeconomic filters directly to the aggregated rows.
    # Each stats row already represents a subgroup with its own average socioeconomic value,
    # so the filter should narrow the underlying rows before aggregation.
    if filters.get('hh_size'):
        if filters.get('hh_size') == 'small':
            conditions.append("(cnt_hh > 0 AND (shh*1.0 / cnt_hh) < 4)")
        elif filters.get('hh_size') == 'medium':
            conditions.append("(cnt_hh > 0 AND (shh*1.0 / cnt_hh) >= 4 AND (shh*1.0 / cnt_hh) < 7)")
        elif filters.get('hh_size') == 'large':
            conditions.append("(cnt_hh > 0 AND (shh*1.0 / cnt_hh) >= 7)")

    if filters.get('father_edu'):
        if filters.get('father_edu') == 'low':
            conditions.append("(cnt_f > 0 AND (sf*1.0 / cnt_f) < 4)")
        elif filters.get('father_edu') == 'secondary':
            conditions.append("(cnt_f > 0 AND (sf*1.0 / cnt_f) >= 4 AND (sf*1.0 / cnt_f) < 7)")
        elif filters.get('father_edu') == 'technical':
            conditions.append("(cnt_f > 0 AND (sf*1.0 / cnt_f) >= 7 AND (sf*1.0 / cnt_f) < 9)")
        elif filters.get('father_edu') == 'university':
            conditions.append("(cnt_f > 0 AND (sf*1.0 / cnt_f) >= 9)")

    if filters.get('mother_edu'):
        if filters.get('mother_edu') == 'low':
            conditions.append("(cnt_m > 0 AND (smoth*1.0 / cnt_m) < 4)")
        elif filters.get('mother_edu') == 'secondary':
            conditions.append("(cnt_m > 0 AND (smoth*1.0 / cnt_m) >= 4 AND (smoth*1.0 / cnt_m) < 7)")
        elif filters.get('mother_edu') == 'technical':
            conditions.append("(cnt_m > 0 AND (smoth*1.0 / cnt_m) >= 7 AND (smoth*1.0 / cnt_m) < 9)")
        elif filters.get('mother_edu') == 'university':
            conditions.append("(cnt_m > 0 AND (smoth*1.0 / cnt_m) >= 9)")

    where_clause = " AND ".join(conditions) if conditions else "1=1"
    
    return where_clause, params, None, []

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/api/geo', methods=['POST'])
def api_geo():
    filters = request.json or {}
    where_clause, params, having_clause, having_params = build_where_clause(filters)
    
    group_col = filters.get('group_by')
    if group_col not in ['depto', 'mcpio']:
        group_col = "mcpio" if filters.get('depto') else "depto"

    query = f"""
        SELECT 
            {group_col} as code,
            SUM(cnt) as count,
            SUM(sg) as sum_sg,
            SUM(sm) as sum_sm,
            SUM(sl) as sum_sl,
            SUM(sc) as sum_sc,
            SUM(ss) as sum_ss,
            SUM(si) as sum_si
        FROM stats
        WHERE {where_clause}
        GROUP BY {group_col}
    """

    if having_clause:
        query += f" HAVING {having_clause}"
        params = params + having_params

    rows = run_query(query, params)
    merged = merge_sum_rows(rows, 'code', ['count', 'sum_sg', 'sum_sm', 'sum_sl', 'sum_sc', 'sum_ss', 'sum_si'])
    results = []
    for row in merged:
        count = float(row['count'] or 0)
        if count <= 0:
            continue
        results.append({
            'code': row['code'],
            'count': int(count),
            'avg_global': row['sum_sg'] / count,
            'avg_mat': row['sum_sm'] / count,
            'avg_lec': row['sum_sl'] / count,
            'avg_cna': row['sum_sc'] / count,
            'avg_soc': row['sum_ss'] / count,
            'avg_ing': row['sum_si'] / count,
        })
    return jsonify(results)

@app.route('/api/trend', methods=['POST'])
def api_trend():
    filters = request.json or {}
    where_clause, params, having_clause, having_params = build_where_clause(filters)
    
    query = f"""
        SELECT 
            periodo,
            SUM(cnt) as count,
            SUM(sg) as sum_sg,
            SUM(sm) as sum_sm,
            SUM(sl) as sum_sl,
            SUM(sc) as sum_sc,
            SUM(ss) as sum_ss,
            SUM(si) as sum_si
        FROM stats
        WHERE {where_clause}
        GROUP BY periodo
    """
    
    if having_clause:
        query += f" HAVING {having_clause}"
        params = params + having_params

    rows = run_query(query, params)
    merged = merge_sum_rows(rows, 'periodo', ['count', 'sum_sg', 'sum_sm', 'sum_sl', 'sum_sc', 'sum_ss', 'sum_si'])
    results = []
    for row in merged:
        count = float(row['count'] or 0)
        if count <= 0:
            continue
        results.append({
            'periodo': row['periodo'],
            'count': int(count),
            'avg_global': row['sum_sg'] / count,
            'avg_mat': row['sum_sm'] / count,
            'avg_lec': row['sum_sl'] / count,
            'avg_cna': row['sum_sc'] / count,
            'avg_soc': row['sum_ss'] / count,
            'avg_ing': row['sum_si'] / count,
        })
    return jsonify(results)

@app.route('/api/distributions', methods=['POST'])
def api_distributions():
    filters = request.json or {}
    where_clause, params, having_clause, having_params = build_where_clause(filters)
    
    def get_dist(col):
        q = f"SELECT {col} as key, SUM(cnt) as count, SUM(sg) as sum_sg FROM stats WHERE {where_clause} GROUP BY {col}"
        q_params = params
        if having_clause:
            q += f" HAVING {having_clause}"
            q_params = params + having_params
        rows = run_query(q, q_params)
        merged = merge_sum_rows(rows, 'key', ['count', 'sum_sg'])
        return [
            {
                'key': row['key'],
                'count': int(row['count'] or 0),
                'avg_global': (row['sum_sg'] / float(row['count'])) if row['count'] else 0.0,
            }
            for row in merged
            if float(row['count'] or 0) > 0
        ]

    dist = {
        'nature': get_dist('n'),
        'area': get_dist('a'),
        'gender': get_dist('g'),
        'stratum': get_dist('s')
    }
    return jsonify(dist)

@app.route('/api/periods')
def api_periods():
    rows = run_query('SELECT DISTINCT periodo FROM stats ORDER BY periodo')
    periods = sorted({r['periodo'] for r in rows})
    return jsonify(periods)

@app.route('/api/mapping')
def api_mapping():
    return jsonify(DANE_MAPPING)

@app.route('/api/clusters', methods=['GET', 'POST'])
def api_clusters():
    filters = request.get_json(silent=True) or {}
    if not filters and request.args:
        filters = dict(request.args)

    where_clause, params, having_clause, having_params = build_where_clause(filters)

    try:
        query = f"""
            SELECT
                depto as code,
                SUM(cnt) as count,
                SUM(sg)/NULLIF(SUM(cnt), 0) as avg_global,
                SUM(CASE WHEN n = 'O' THEN cnt ELSE 0 END) * 1.0 / NULLIF(SUM(cnt), 0) as pct_oficial,
                SUM(CASE WHEN a = 'R' THEN cnt ELSE 0 END) * 1.0 / NULLIF(SUM(cnt), 0) as pct_rural,
                SUM(CASE WHEN s IN (1, 2) THEN cnt ELSE 0 END) * 1.0 / NULLIF(SUM(cnt), 0) as pct_stratum12,
                SUM(shh) * 1.0 / NULLIF(SUM(cnt_hh), 0) as avg_hh,
                SUM(sf) * 1.0 / NULLIF(SUM(cnt_f), 0) as avg_fedu,
                SUM(smoth) * 1.0 / NULLIF(SUM(cnt_m), 0) as avg_medu
            FROM stats
            WHERE {where_clause}
            GROUP BY depto
        """
        rows = run_query(query, params)

        clusters = _compute_clusters_from_rows(rows)
        if clusters:
            return jsonify(clusters)

        clusters_path = os.path.join(BASE_DIR, 'clusters.json')
        with open(clusters_path, encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
